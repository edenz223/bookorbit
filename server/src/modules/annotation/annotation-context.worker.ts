import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'fs/promises';

import { BOOK_FILE_CHANGED, BOOK_CONTEXT_CHANGED, bookFileEvents } from '../../common/utils/book-file-events';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { PositionConverterService } from '../position-converter/position-converter.service';
import { AnnotationContextRepository, type AnnotationContextInput, type ContextClaim } from './annotation-context.repository';

export async function contextPhysicalFingerprint(file: {
  absolutePath: string;
  format: string | null;
  databaseFingerprint?: string;
}): Promise<string> {
  const info = await stat(file.absolutePath);
  return createHash('sha256')
    .update(JSON.stringify([file.absolutePath, file.format, file.databaseFingerprint, info.size, info.mtimeMs, info.ctimeMs]))
    .digest('hex');
}

@Injectable()
export class AnnotationContextWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AnnotationContextWorker.name);
  private running = false;
  private stopped = false;
  private activeToken: string | null = null;
  private lastSummaryAt = 0;
  private readonly onFileChanged = (fileId: number) => {
    void this.repository.markFileChanged(fileId).catch((error) => this.logFailure('file_change', error));
  };
  private readonly onBookChanged = (bookId: number) => {
    void this.repository.markBookChanged(bookId).catch((error) => this.logFailure('book_change', error));
  };

  constructor(
    private readonly repository: AnnotationContextRepository,
    private readonly converter: PositionConverterService,
  ) {}

  onApplicationBootstrap(): void {
    bookFileEvents.on(BOOK_FILE_CHANGED, this.onFileChanged);
    bookFileEvents.on(BOOK_CONTEXT_CHANGED, this.onBookChanged);
    void this.tick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    bookFileEvents.off(BOOK_FILE_CHANGED, this.onFileChanged);
    bookFileEvents.off(BOOK_CONTEXT_CHANGED, this.onBookChanged);
  }

  @Interval(30_000)
  async renewLease(): Promise<void> {
    if (!this.activeToken || this.stopped) return;
    await this.repository.renew(this.activeToken).catch((error) => this.logFailure('lease', error));
  }

  @Interval(5_000)
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const token = randomUUID();
    const startedAt = Date.now();
    this.activeToken = token;
    let claimed = 0;
    try {
      const backfill = await this.repository.backfill(token);
      await this.checkDueFiles(token);
      const invalidated = (await this.repository.invalidateFileBatch()) + (await this.repository.invalidateBookBatch());
      const jobs = await this.repository.claim(token);
      claimed = jobs.length;
      const summarize = Date.now() - this.lastSummaryAt >= 60_000 && (claimed || backfill.scanned || invalidated);
      if (summarize)
        this.logger.log(`[annotation.context_batch] [start] claimed=${claimed} backfillScanned=${backfill.scanned} - context batch started`);
      const totals = await this.process(jobs);
      if (summarize) {
        this.lastSummaryAt = Date.now();
        this.logger.log(
          `[annotation.context_batch] [end] durationMs=${Date.now() - startedAt} claimed=${claimed} ready=${totals.ready} unavailable=${totals.unavailable} failed=${totals.failed} stale=${totals.stale} backfillScanned=${backfill.scanned} backfillCursor=${backfill.cursor} invalidated=${invalidated} backlog=${await this.repository.backlog()} - context batch completed`,
        );
      }
    } catch (error) {
      this.logFailure('batch', error, startedAt, claimed);
    } finally {
      this.activeToken = null;
      this.running = false;
    }
  }

  private async checkDueFiles(token: string): Promise<void> {
    const jobs = await this.repository.claimFiles(token);
    const snapshots: { bookFileId: number; fingerprint: string; databaseFingerprint?: string }[] = [];
    let next = 0;
    const check = async () => {
      while (next < jobs.length) {
        const file = jobs[next++];
        let fingerprint: string;
        try {
          fingerprint = await contextPhysicalFingerprint(file);
        } catch {
          fingerprint = createHash('sha256')
            .update(JSON.stringify([file.absolutePath, file.format, file.databaseFingerprint, 'missing']))
            .digest('hex');
        }
        snapshots.push({ bookFileId: file.bookFileId, fingerprint, databaseFingerprint: file.databaseFingerprint });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, check));
    await this.repository.recordFiles(token, snapshots);
  }

  private async inputs(jobs: ContextClaim[]): Promise<AnnotationContextInput[]> {
    const groups = new Map<number, number[]>();
    for (const job of jobs) groups.set(job.userId, [...(groups.get(job.userId) ?? []), job.annotationId]);
    const result: AnnotationContextInput[] = [];
    for (const [userId, ids] of groups) result.push(...(await this.repository.getInputs(userId, ids)));
    return result;
  }

  private async process(jobs: ContextClaim[]) {
    const totals = { ready: 0, unavailable: 0, failed: 0, stale: 0 };
    if (!jobs.length) return totals;
    let inputs = await this.inputs(jobs);
    const physical = new Map<number, string>();
    const failures = new Set<number>();
    const fileGroups = new Map<number, AnnotationContextInput[]>();
    for (const input of inputs) {
      if (input.bookFileId != null && input.absolutePath && ['epub', 'kepub'].includes(input.format ?? '')) {
        fileGroups.set(input.bookFileId, [...(fileGroups.get(input.bookFileId) ?? []), input]);
      }
    }
    for (const [fileId, group] of fileGroups) {
      try {
        await this.repository.registerFile(fileId);
        const fingerprint = await contextPhysicalFingerprint(group[0] as { absolutePath: string; format: string | null });
        physical.set(fileId, fingerprint);
        await this.repository.recordFile(fileId, fingerprint, group[0].databaseFingerprint);
      } catch {
        for (const input of group) failures.add(input.annotationId);
      }
    }
    inputs = await this.inputs(jobs);
    const supported = inputs.filter(
      (input) =>
        input.cfi &&
        input.bookFileId != null &&
        input.absolutePath &&
        ['epub', 'kepub'].includes(input.format ?? '') &&
        ['exact', 'repaired'].includes(input.positionStatus ?? '') &&
        !failures.has(input.annotationId),
    );
    const contexts = await this.converter.getHighlightContexts(
      supported.map((input) => ({ ...input, cfi: input.cfi!, bookFileId: input.bookFileId!, absolutePath: input.absolutePath! })),
      {
        concurrency: 2,
        onFailure: (id) => failures.add(id),
      },
    );
    for (const [fileId, group] of fileGroups) {
      if (!physical.has(fileId)) continue;
      try {
        if ((await contextPhysicalFingerprint(group[0] as { absolutePath: string; format: string | null })) !== physical.get(fileId)) {
          await this.repository.markFileChanged(fileId);
          for (const input of group) failures.add(input.annotationId);
        }
      } catch {
        for (const input of group) failures.add(input.annotationId);
      }
    }
    const byId = new Map(inputs.map((input) => [input.annotationId, input]));
    for (const job of jobs) {
      if (this.stopped) break;
      const input = byId.get(job.annotationId);
      if (!input) continue;
      if (failures.has(job.annotationId)) {
        await this.repository.fail(job, 'file_or_parse_unavailable', input.inputFingerprint);
        totals.failed++;
        continue;
      }
      const context = contexts.get(job.annotationId) ?? null;
      const reason = context ? null : !['epub', 'kepub'].includes(input.format ?? '') ? 'unsupported_format' : 'position_unavailable';
      if (await this.repository.finish(job, input.inputFingerprint, input.bookFileId, context, reason)) {
        if (context) totals.ready++;
        else totals.unavailable++;
      } else totals.stale++;
    }
    return totals;
  }

  private logFailure(phase: string, error: unknown, startedAt = Date.now(), claimed = 0): void {
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `[annotation.context_batch] [fail] phase=${phase} durationMs=${Date.now() - startedAt} claimed=${claimed} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - context background work failed`,
    );
  }
}
