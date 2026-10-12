import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { ZipArchive } from 'archiver';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { AnnotationRepository } from './annotation.repository';
import { AnnotationSyncRepository } from './annotation-sync.repository';
import { AnnotationContextRepository } from './annotation-context.repository';
import { AnnotationContextService } from './annotation-context.service';
import { AnnotationContextWorker } from './annotation-context.worker';
import { scheduleContextRows } from './annotation-context.inputs';
import { EpubDomService } from '../position-converter/epub-dom.service';
import { PositionConverterService } from '../position-converter/position-converter.service';

const databaseUrl = process.env.CONTEXT_TEST_DATABASE_URL;
vi.mock('fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs/promises')>();
  return { ...original, stat: vi.fn(original.stat) };
});

describe.skipIf(!databaseUrl)('annotation context PostgreSQL persistence', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: AnnotationContextRepository;
  let annotations: AnnotationRepository;
  let sync: AnnotationSyncRepository;
  let worker: AnnotationContextWorker;
  let dir: string;
  let epubPath: string;
  let userId: number;
  let otherUserId: number;
  let bookId: number;
  let fileId: number;
  const cfi = 'epubcfi(/6/2!/4/2,/1:8,/1:13)';

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.startsWith('/bookorbit_context_test'))
      throw new Error('Context persistence tests require an isolated bookorbit_context_test database');
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = drizzle(pool, { schema });
    dir = await mkdtemp(join(tmpdir(), 'bookorbit-context-'));
    epubPath = join(dir, 'test.epub');
    const zip = new ZipArchive({ zlib: { level: 0 } });
    const chunks: Buffer[] = [];
    zip.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      zip.on('end', resolve);
      zip.on('error', reject);
    });
    zip.append('application/epub+zip', { name: 'mimetype', store: true });
    zip.append('<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>', { name: 'META-INF/container.xml' });
    zip.append('<package><manifest><item id="ch1" href="chapter.xhtml"/></manifest><spine><itemref idref="ch1"/></spine></package>', {
      name: 'content.opf',
    });
    zip.append('<html><head><title>Test</title></head><body><p>Before. MARK. After.</p></body></html>', { name: 'chapter.xhtml' });
    await zip.finalize();
    await done;
    await writeFile(epubPath, Buffer.concat(chunks));
  });

  beforeEach(async () => {
    await db.execute(sql`truncate ${schema.annotationContexts}, ${schema.annotationContextFiles}, ${schema.annotationContextMaintenance}, ${schema.annotations}, ${schema.annotationPositions},
      ${schema.users}, ${schema.books}, ${schema.bookFiles}, ${schema.libraryFolders}, ${schema.libraries} restart identity cascade`);
    const users = await db
      .insert(schema.users)
      .values([
        { username: 'context-owner', name: 'Context owner', passwordHash: 'test-only', active: false },
        { username: 'context-other', name: 'Context other', passwordHash: 'test-only', active: false },
      ])
      .returning();
    userId = users[0].id;
    otherUserId = users[1].id;
    const [library] = await db.insert(schema.libraries).values({ name: 'Context fixture' }).returning();
    const [folder] = await db.insert(schema.libraryFolders).values({ libraryId: library.id, path: dir }).returning();
    const [book] = await db.insert(schema.books).values({ libraryId: library.id, libraryFolderId: folder.id, folderPath: dir }).returning();
    bookId = book.id;
    const [file] = await db
      .insert(schema.bookFiles)
      .values({ bookId, libraryFolderId: folder.id, absolutePath: epubPath, format: 'epub', ino: 1n })
      .returning();
    fileId = file.id;
    await db.update(schema.books).set({ primaryFileId: fileId }).where(eq(schema.books.id, bookId));
    const module = await Test.createTestingModule({
      providers: [
        AnnotationContextRepository,
        AnnotationRepository,
        AnnotationSyncRepository,
        AnnotationContextWorker,
        EpubDomService,
        PositionConverterService,
        { provide: DB, useValue: db },
      ],
    }).compile();
    repository = module.get(AnnotationContextRepository);
    annotations = module.get(AnnotationRepository);
    sync = module.get(AnnotationSyncRepository);
    worker = module.get(AnnotationContextWorker);
  });

  afterAll(async () => {
    await pool?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function create() {
    return annotations.create({ userId, bookId, text: 'MARK.', cfi, bookFileId: fileId });
  }

  async function contextRow(annotationId: number) {
    return (await db.select().from(schema.annotationContexts).where(eq(schema.annotationContexts.annotationId, annotationId)))[0];
  }

  it('commits the queue with creation, generates real EPUB context and survives service restart', async () => {
    const row = await create();
    expect((await contextRow(row.id)).status).toBe('pending');
    await worker.tick();
    expect((await contextRow(row.id)).status).toBe('ready');
    const stored = await repository.getStored(userId, [row.id]);
    expect(stored).toEqual([{ annotationId: row.id, before: 'Before. ', after: ' After.' }]);
    const restart = new AnnotationContextService(new AnnotationContextRepository(db));
    expect(await restart.enrich(userId, [{ id: row.id }])).toEqual([{ id: row.id, context: { before: 'Before. ', after: ' After.' } }]);
    expect((await db.select().from(schema.annotations).where(eq(schema.annotations.id, row.id)))[0].version).toBe(1);
  });

  it('isolates users and reads only ready rows for the requested page', async () => {
    const first = await create();
    const second = await create();
    await worker.tick();
    expect(await repository.getStored(otherUserId, [first.id, second.id])).toEqual([]);
    expect((await repository.getStored(userId, [second.id])).map((row) => row.annotationId)).toEqual([second.id]);
    expect(await repository.getStored(userId, [])).toEqual([]);
  });

  it('atomically claims at most 25 jobs and does not double-claim across workers', async () => {
    for (let i = 0; i < 30; i++) await create();
    const [first, second] = await Promise.all([repository.claim(randomUUID()), repository.claim(randomUUID())]);
    expect(first.length).toBeLessThanOrEqual(25);
    expect(second.length).toBeLessThanOrEqual(25);
    expect(first.length + second.length).toBe(30);
    expect(new Set([...first, ...second].map((row) => row.annotationId)).size).toBe(30);
  });

  it('recovers expired leases and prevents a previous worker from committing', async () => {
    const row = await create();
    const [old] = await repository.claim(randomUUID());
    const [input] = await repository.getInputs(userId, [row.id]);
    await db
      .update(schema.annotationContexts)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.annotationContexts.annotationId, row.id));
    const [current] = await repository.claim(randomUUID());
    expect(current.leaseToken).not.toBe(old.leaseToken);
    expect(await repository.finish(old, input.inputFingerprint, fileId, { before: 'old', after: '' }, null)).toBe(false);
    expect((await contextRow(row.id)).leaseToken).toBe(current.leaseToken);
  });

  it('rejects stale fingerprints while edits enqueue a new generation in the same transaction', async () => {
    const row = await create();
    const [job] = await repository.claim(randomUUID());
    const [input] = await repository.getInputs(userId, [row.id]);
    await sync.applyContentPatch(row.id, { text: 'changed' });
    expect((await contextRow(row.id)).generation).toBeGreaterThan(job.generation);
    expect(await repository.finish(job, input.inputFingerprint, fileId, { before: 'old', after: '' }, null)).toBe(false);
    expect(await repository.getStored(userId, [row.id])).toEqual([]);
  });

  it('hides obsolete algorithm results and restarts backfill for the new version', async () => {
    const row = await create();
    await worker.tick();
    const generation = (await contextRow(row.id)).generation;
    await db.update(schema.annotationContexts).set({ algorithmVersion: 0 }).where(eq(schema.annotationContexts.annotationId, row.id));
    await db.update(schema.annotationContextMaintenance).set({ algorithmVersion: 0 }).where(eq(schema.annotationContextMaintenance.name, 'backfill'));
    expect(await repository.getStored(userId, [row.id])).toEqual([]);
    expect(await repository.backfill(randomUUID())).toMatchObject({ scanned: 1, queued: 1 });
    expect(await contextRow(row.id)).toMatchObject({ status: 'pending', algorithmVersion: 1, generation: generation + 1 });
    await worker.tick();
    expect(await repository.getStored(userId, [row.id])).toHaveLength(1);
  });
  it('does not invalidate context for note, color or star changes', async () => {
    const row = await create();
    await worker.tick();
    const generation = (await contextRow(row.id)).generation;
    await annotations.update(bookId, row.id, userId, { color: 'yellow', note: 'note' }, { starred: true });
    expect((await contextRow(row.id)).generation).toBe(generation);
    expect(await repository.getStored(userId, [row.id])).toHaveLength(1);
  });

  it('invalidates file metadata immediately and queues file changes in bounded batches', async () => {
    const row = await create();
    await worker.tick();
    await db.update(schema.bookFiles).set({ sizeBytes: 1000 }).where(eq(schema.bookFiles.id, fileId));
    expect(await repository.getStored(userId, [row.id])).toEqual([]);
    await repository.markFileChanged(fileId);
    const token = randomUUID();
    await repository.claimFiles(token);
    await repository.recordFiles(token, [{ bookFileId: fileId, fingerprint: 'changed-file' }]);
    expect(await repository.invalidateFileBatch()).toBe(1);
    expect((await contextRow(row.id)).status).toBe('pending');
  });

  it('checks and persists file verification leases without duplicate claims', async () => {
    await create();
    await worker.tick();
    await repository.markFileChanged(fileId);
    const token = randomUUID();
    const first = await repository.claimFiles(token);
    expect(first.map((row) => row.bookFileId)).toEqual([fileId]);
    expect(await repository.claimFiles(randomUUID())).toEqual([]);
    await repository.recordFiles(token, [{ bookFileId: fileId, fingerprint: 'changed-file' }]);
    const [file] = await db.select().from(schema.annotationContextFiles);
    expect(file.leaseToken).toBeNull();
    expect(file.fingerprint).toBe('changed-file');
    expect(file.invalidationPending).toBe(true);
    expect(file.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rechecks a file when database metadata changes during its verification', async () => {
    await create();
    await worker.tick();
    await repository.markFileChanged(fileId);
    const token = randomUUID();
    const [snapshot] = await repository.claimFiles(token);
    await db.update(schema.bookFiles).set({ sizeBytes: 2000 }).where(eq(schema.bookFiles.id, fileId));
    await repository.recordFiles(token, [{ ...snapshot, fingerprint: 'old-snapshot' }]);
    const [file] = await db.select().from(schema.annotationContextFiles);
    expect(file.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await repository.claimFiles(randomUUID())).toHaveLength(1);
  });

  it('rejects a stale file snapshot recorded by a context generator', async () => {
    const row = await create();
    await worker.tick();
    const [input] = await repository.getInputs(userId, [row.id]);
    const [original] = await db.select().from(schema.annotationContextFiles);
    await db.update(schema.bookFiles).set({ sizeBytes: 2000 }).where(eq(schema.bookFiles.id, fileId));
    await repository.recordFile(fileId, 'stale-snapshot', input.databaseFingerprint);
    const [file] = await db.select().from(schema.annotationContextFiles);
    expect(file.fingerprint).toBe(original.fingerprint);
  });
  it('queues primary-file changes when an unanchored CFI follows the primary file', async () => {
    const row = await annotations.create({ userId, bookId, text: 'MARK.', cfi, bookFileId: null });
    await worker.tick();
    const [file] = await db
      .insert(schema.bookFiles)
      .values({
        bookId,
        libraryFolderId: (await db.select().from(schema.bookFiles))[0].libraryFolderId,
        absolutePath: join(dir, 'alternate.epub'),
        format: 'epub',
        ino: 2n,
      })
      .returning();
    await db.update(schema.books).set({ primaryFileId: file.id }).where(eq(schema.books.id, bookId));
    expect(await repository.getStored(userId, [row.id])).toEqual([]);
    await repository.markBookChanged(bookId);
    expect(await repository.invalidateBookBatch()).toBe(1);
    expect((await contextRow(row.id)).status).toBe('pending');
  });

  it('queues corrected CFI positions and persists permanent positioning failures', async () => {
    const row = await create();
    await worker.tick();
    await sync.upsertPosition({ annotationId: row.id, userId, bookFileId: fileId, format: 'cfi', pos0: 'invalid', status: 'exact' });
    expect((await contextRow(row.id)).status).toBe('pending');
    expect(await repository.getStored(userId, [row.id])).toEqual([]);
    await worker.tick();
    expect((await contextRow(row.id)).status).toBe('unavailable');
    expect((await contextRow(row.id)).availableAt).toBeNull();
  });

  it('backfills 200 at a time and resumes the durable cursor after restart', async () => {
    const rows = await db
      .insert(schema.annotations)
      .values(Array.from({ length: 250 }, () => ({ userId, bookId, text: 'MARK.' })))
      .returning();
    await db
      .insert(schema.annotationPositions)
      .values(rows.map((row) => ({ annotationId: row.id, userId, bookFileId: fileId, format: 'cfi' as const, pos0: cfi })));
    expect(await repository.backfill(randomUUID())).toMatchObject({ scanned: 200, queued: 200, cursor: 200 });
    const restart = new AnnotationContextRepository(db);
    expect(await restart.backfill(randomUUID())).toMatchObject({ scanned: 50, queued: 50, cursor: 250 });
    expect(await restart.backfill(randomUUID())).toMatchObject({ scanned: 0, queued: 0 });
    expect(await db.select().from(schema.annotationContexts)).toHaveLength(250);
  });

  it('pauses deleted annotations, queues restored ones and cascades hard deletion', async () => {
    const row = await create();
    await annotations.softDelete(bookId, row.id, userId);
    expect(await repository.claim(randomUUID())).toEqual([]);
    await annotations.restore(row.id, userId);
    expect(await repository.claim(randomUUID())).toHaveLength(1);
    await db.delete(schema.annotations).where(and(eq(schema.annotations.id, row.id), eq(schema.annotations.userId, userId)));
    expect(await contextRow(row.id)).toBeUndefined();
  });

  it('does not leak a context row with a mismatched owner', async () => {
    const row = await create();
    await worker.tick();
    await db.update(schema.annotationContexts).set({ userId: otherUserId }).where(eq(schema.annotationContexts.annotationId, row.id));
    expect(await repository.getStored(userId, [row.id])).toEqual([]);
    expect(await repository.getStored(otherUserId, [row.id])).toEqual([]);
  });

  it('bounds retry attempts and stops scheduling after the fifth retry', async () => {
    const row = await create();
    for (let attempt = 0; attempt < 6; attempt++) {
      await db
        .update(schema.annotationContexts)
        .set({ availableAt: new Date(0) })
        .where(eq(schema.annotationContexts.annotationId, row.id));
      const [job] = await repository.claim(randomUUID());
      await repository.fail(job, 'file_or_parse_unavailable');
    }
    expect((await contextRow(row.id)).attemptCount).toBe(6);
    expect((await contextRow(row.id)).availableAt).toBeNull();
    expect(await repository.claim(randomUUID())).toEqual([]);
  });

  it('serves a large cached page without invoking the parser', async () => {
    const inserted = await db.execute<
      Pick<typeof schema.annotations.$inferSelect, 'id'>
    >(sql`insert into ${schema.annotations} (user_id, book_id, text)
      select ${userId}, ${bookId}, 'MARK.' from generate_series(1, 50000) returning id`);
    const rows = inserted.rows;
    await db.execute(sql`insert into ${schema.annotationPositions} (annotation_id, user_id, book_file_id, format, pos0)
      select ${schema.annotations.id}, ${userId}, ${fileId}, 'cfi', ${cfi} from ${schema.annotations} where ${schema.annotations.userId} = ${userId}`);
    await scheduleContextRows(db, and(eq(schema.annotations.userId, userId), eq(schema.annotations.bookId, bookId))!, 0);
    const page = rows.slice(450, 500).map((row) => row.id);
    const inputs = await repository.getInputs(userId, page);
    await db
      .update(schema.annotationContexts)
      .set({ status: 'processing', leaseToken: randomUUID() })
      .where(inArray(schema.annotationContexts.annotationId, page));
    const claims = await db.select().from(schema.annotationContexts).where(inArray(schema.annotationContexts.annotationId, page));
    for (const input of inputs) {
      await repository.finish(
        claims.find((row) => row.annotationId === input.annotationId)!,
        input.inputFingerprint,
        fileId,
        { before: 'Before. ', after: ' After.' },
        null,
      );
    }
    const parse = vi.spyOn(PositionConverterService.prototype, 'getHighlightContexts');
    const fileStat = vi.mocked(fs.stat);
    fileStat.mockClear();
    const service = new AnnotationContextService(repository);
    const start = performance.now();
    expect(
      await service.enrich(
        userId,
        page.map((id) => ({ id })),
      ),
    ).toHaveLength(50);
    console.info(`Persisted context page: annotations=50000 pageSize=50 durationMs=${(performance.now() - start).toFixed(1)}`);
    expect(parse).not.toHaveBeenCalled();
    expect(fileStat).not.toHaveBeenCalled();
    parse.mockRestore();
    fileStat.mockClear();
    await db.execute(sql`analyze ${schema.annotationContexts}`);
    const plan = await db.execute(
      sql`explain select annotation_id from ${schema.annotationContexts} where user_id = ${userId} and annotation_id in (${sql.join(
        page.map((id) => sql`${id}`),
        sql`,`,
      )})`,
    );
    expect(plan.rows.some((row) => String(row['QUERY PLAN']).includes('Index'))).toBe(true);
  });
});
