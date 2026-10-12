import { Test } from '@nestjs/testing';
import { stat } from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PositionConverterService } from '../position-converter/position-converter.service';
import { AnnotationContextRepository, CONTEXT_RETRY_DELAYS } from './annotation-context.repository';
import { AnnotationContextWorker } from './annotation-context.worker';

vi.mock('fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs/promises')>()), stat: vi.fn() }));

beforeEach(() =>
  vi
    .mocked(stat)
    .mockReset()
    .mockResolvedValue({ size: 100, mtimeMs: 1, ctimeMs: 1 } as never),
);

async function fixture() {
  const jobs = [{ annotationId: 1, userId: 7, generation: 1, attemptCount: 0, leaseToken: 'token' }];
  const input = {
    annotationId: 1,
    userId: 7,
    bookFileId: 3,
    text: 'MARK',
    cfi: 'cfi',
    positionStatus: 'exact',
    absolutePath: '/book.epub',
    format: 'epub',
    inputFingerprint: 'fingerprint',
  };
  const repository = {
    backfill: vi.fn().mockResolvedValue({ scanned: 0, queued: 0, cursor: 1 }),
    claimFiles: vi.fn().mockResolvedValue([]),
    recordFiles: vi.fn(),
    invalidateFileBatch: vi.fn().mockResolvedValue(0),
    invalidateBookBatch: vi.fn().mockResolvedValue(0),
    markBookChanged: vi.fn(),
    claim: vi.fn().mockResolvedValue(jobs),
    getInputs: vi.fn().mockResolvedValue([input]),
    registerFile: vi.fn(),
    recordFile: vi.fn(),
    finish: vi.fn().mockResolvedValue(true),
    fail: vi.fn(),
    renew: vi.fn(),
    backlog: vi.fn().mockResolvedValue(0),
    markFileChanged: vi.fn(),
  };
  const converter = { getHighlightContexts: vi.fn().mockResolvedValue(new Map([[1, { before: 'before ', after: ' after' }]])) };
  const module = await Test.createTestingModule({
    providers: [
      AnnotationContextWorker,
      { provide: AnnotationContextRepository, useValue: repository },
      { provide: PositionConverterService, useValue: converter },
    ],
  }).compile();
  return { worker: module.get(AnnotationContextWorker), repository, converter, input, jobs };
}

describe('persistent annotation context worker', () => {
  it('processes only claimed user-owned rows with chapter concurrency two', async () => {
    const { worker, repository, converter, jobs } = await fixture();
    await worker.tick();
    expect(repository.getInputs).toHaveBeenCalledWith(7, [1]);
    expect(converter.getHighlightContexts).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ concurrency: 2 }));
    expect(repository.finish).toHaveBeenCalledWith(jobs[0], 'fingerprint', 3, { before: 'before ', after: ' after' }, null);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('records unsupported items without parsing them', async () => {
    const { worker, repository, converter, input } = await fixture();
    converter.getHighlightContexts.mockResolvedValue(new Map());
    repository.getInputs.mockResolvedValue([{ ...input, format: 'pdf', cfi: null }]);
    await worker.tick();
    expect(stat).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledWith(expect.any(Object), 'fingerprint', 3, null, 'unsupported_format');
  });

  it('retries file and converter failures without committing an unavailable result', async () => {
    const { worker, repository, converter } = await fixture();
    converter.getHighlightContexts.mockImplementation((_sources, options) => {
      options.onFailure(1);
      return Promise.resolve(new Map([[1, null]]));
    });
    await worker.tick();
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }), 'file_or_parse_unavailable', 'fingerprint');
    expect(repository.finish).not.toHaveBeenCalled();
  });

  it('does not commit when file content changes during parsing', async () => {
    const { worker, repository } = await fixture();
    vi.mocked(stat)
      .mockResolvedValueOnce({ size: 100, mtimeMs: 1, ctimeMs: 1 } as never)
      .mockResolvedValueOnce({ size: 101, mtimeMs: 2, ctimeMs: 2 } as never);
    await worker.tick();
    expect(repository.markFileChanged).toHaveBeenCalledWith(3);
    expect(repository.finish).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalled();
  });

  it('does not overlap local ticks or wait for backfill during startup', async () => {
    const { worker, repository } = await fixture();
    let release!: () => void;
    repository.backfill.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ scanned: 0, queued: 0, cursor: 1 });
      }),
    );
    worker.onApplicationBootstrap();
    await worker.tick();
    expect(repository.backfill).toHaveBeenCalledTimes(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    worker.onModuleDestroy();
  });

  it('uses the specified five retry delays', () => {
    expect(CONTEXT_RETRY_DELAYS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]);
  });
});
