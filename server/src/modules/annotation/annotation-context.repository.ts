import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import {
  annotationContexts as contexts,
  annotationContextFiles as files,
  annotationContextMaintenance as maintenance,
  annotations,
  books,
  bookFiles,
} from '../../db/schema';
import {
  CONTEXT_ALGORITHM_VERSION,
  contextFileId,
  contextFingerprint,
  contextPosition,
  contextPdfPosition,
  contextDatabaseFileFingerprint,
  contextSourceFrom,
  scheduleContextRows,
} from './annotation-context.inputs';

type Db = NodePgDatabase<typeof schema>;
export type ContextClaim = Pick<typeof contexts.$inferSelect, 'annotationId' | 'userId' | 'generation' | 'attemptCount' | 'leaseToken'>;
export const CONTEXT_RETRY_DELAYS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];

@Injectable()
export class AnnotationContextRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private sources() {
    return this.db
      .select({
        annotationId: annotations.id,
        bookId: annotations.bookId,
        userId: annotations.userId,
        text: annotations.text,
        cfi: contextPosition.pos0,
        positionStatus: contextPosition.status,
        bookFileId: bookFiles.id,
        absolutePath: bookFiles.absolutePath,
        format: bookFiles.format,
        inputFingerprint: contextFingerprint,
        databaseFingerprint: contextDatabaseFileFingerprint,
      })
      .from(annotations)
      .innerJoin(books, eq(books.id, annotations.bookId))
      .leftJoin(
        contextPosition,
        and(eq(contextPosition.annotationId, annotations.id), eq(contextPosition.userId, annotations.userId), eq(contextPosition.format, 'cfi')),
      )
      .leftJoin(
        contextPdfPosition,
        and(
          eq(contextPdfPosition.annotationId, annotations.id),
          eq(contextPdfPosition.userId, annotations.userId),
          eq(contextPdfPosition.format, 'pdf'),
        ),
      )
      .leftJoin(bookFiles, and(eq(bookFiles.id, contextFileId), eq(bookFiles.bookId, annotations.bookId)))
      .leftJoin(files, eq(files.bookFileId, bookFiles.id));
  }

  async getInputs(userId: number, ids: number[]) {
    if (!ids.length) return [];
    return this.sources().where(and(eq(annotations.userId, userId), inArray(annotations.id, ids), isNull(annotations.deletedAt)));
  }

  async getStored(userId: number, ids: number[]) {
    if (!ids.length) return [];
    const result = await this.db.execute<Pick<typeof contexts.$inferSelect, 'annotationId' | 'before' | 'after'>>(sql`
      select ${contexts.annotationId} as "annotationId", ${contexts.before} as before, ${contexts.after} as after
      ${contextSourceFrom}
      join ${contexts} on ${contexts.annotationId} = ${annotations.id} and ${contexts.userId} = ${annotations.userId}
      where ${annotations.userId} = ${userId} and ${annotations.id} in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`,`,
      )})
        and ${contexts.status} = 'ready' and ${contexts.algorithmVersion} = ${CONTEXT_ALGORITHM_VERSION}
        and ${contexts.inputFingerprint} = ${contextFingerprint}
    `);
    return result.rows;
  }

  async claim(token: string): Promise<ContextClaim[]> {
    const result = await this.db.execute<ContextClaim>(sql`
      with due as (
        select ${contexts.annotationId} from ${contexts}
        join ${annotations} on ${annotations.id} = ${contexts.annotationId} and ${annotations.userId} = ${contexts.userId}
        where ${annotations.deletedAt} is null and (
          (${contexts.status} in ('pending', 'failed') and ${contexts.availableAt} <= now()) or
          (${contexts.status} = 'processing' and ${contexts.leaseExpiresAt} < now())
        ) order by ${contexts.priority} desc, ${contexts.availableAt}, ${contexts.annotationId}
        limit 25 for update of ${contexts} skip locked
      )
      update ${contexts} set status = 'processing', lease_token = ${token}::uuid,
        lease_expires_at = now() + interval '2 minutes', updated_at = now()
      where annotation_id in (select annotation_id from due)
      returning annotation_id as "annotationId", user_id as "userId", generation, attempt_count as "attemptCount", lease_token as "leaseToken"
    `);
    return result.rows;
  }

  async renew(token: string): Promise<void> {
    await this.db.execute(
      sql`update ${contexts} set lease_expires_at = now() + interval '2 minutes' where lease_token = ${token}::uuid and status = 'processing'`,
    );
    await this.db.execute(sql`update ${files} set lease_expires_at = now() + interval '2 minutes' where lease_token = ${token}::uuid`);
    await this.db.execute(sql`update ${maintenance} set lease_expires_at = now() + interval '2 minutes' where lease_token = ${token}::uuid`);
  }

  async finish(
    job: ContextClaim,
    fingerprint: string,
    fileId: number | null,
    context: { before: string; after: string } | null,
    reason: string | null,
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      update ${contexts} set status = ${context ? 'ready' : 'unavailable'}, before = ${context?.before ?? null}, after = ${context?.after ?? null},
        input_fingerprint = ${fingerprint}, book_file_id = ${fileId}, algorithm_version = ${CONTEXT_ALGORITHM_VERSION}, reason = ${reason},
        generated_at = now(), available_at = null, lease_token = null, lease_expires_at = null, updated_at = now()
      where annotation_id = ${job.annotationId} and user_id = ${job.userId} and generation = ${job.generation} and lease_token = ${job.leaseToken}::uuid
        and exists (select 1 ${contextSourceFrom} where ${annotations.id} = ${job.annotationId} and ${annotations.userId} = ${job.userId}
          and ${annotations.deletedAt} is null and ${contextFingerprint} = ${fingerprint})
      returning annotation_id
    `);
    if (result.rowCount) return true;
    // A changed input must be retried rather than leave the old lease stuck until expiry.
    await this.db.execute(sql`update ${contexts} set status = 'pending', available_at = now(), lease_token = null, lease_expires_at = null
      where annotation_id = ${job.annotationId} and user_id = ${job.userId} and generation = ${job.generation} and lease_token = ${job.leaseToken}::uuid`);
    return false;
  }

  async fail(job: ContextClaim, reason: string, fingerprint?: string): Promise<void> {
    const delay = CONTEXT_RETRY_DELAYS[job.attemptCount];
    const availableAt = delay == null ? null : new Date(Date.now() + delay);
    await this.db.execute(sql`update ${contexts} set status = 'failed', reason = ${reason}, attempt_count = attempt_count + 1,
      input_fingerprint = coalesce(${fingerprint ?? null}, input_fingerprint),
      available_at = ${availableAt}, lease_token = null, lease_expires_at = null, updated_at = now()
      where annotation_id = ${job.annotationId} and user_id = ${job.userId} and generation = ${job.generation} and lease_token = ${job.leaseToken}::uuid`);
  }

  async backfill(token: string): Promise<{ scanned: number; queued: number; cursor: number }> {
    return this.db.transaction(async (tx) => {
      await tx.insert(maintenance).values({ name: 'backfill' }).onConflictDoNothing();
      const locked = await tx.execute<
        typeof maintenance.$inferSelect
      >(sql`select name, cursor, upper_bound as "upperBound", algorithm_version as "algorithmVersion", completed_at as "completedAt"
        from ${maintenance} where name = 'backfill' for update skip locked`);
      const state = locked.rows[0];
      if (!state || (state.completedAt && state.algorithmVersion === CONTEXT_ALGORITHM_VERSION))
        return { scanned: 0, queued: 0, cursor: state?.cursor ?? 0 };
      const reset = state.algorithmVersion !== CONTEXT_ALGORITHM_VERSION;
      const cursor = reset ? 0 : state.cursor;
      const [bound] = await tx.select({ id: sql<number>`coalesce(max(${annotations.id}), 0)` }).from(annotations);
      const upperBound = reset || state.upperBound == null ? bound.id : state.upperBound;
      const batch = await tx
        .select({ id: annotations.id })
        .from(annotations)
        .where(and(gt(annotations.id, cursor), lte(annotations.id, upperBound)))
        .orderBy(asc(annotations.id))
        .limit(200);
      const ids = batch.map((row) => row.id);
      const queued = ids.length ? await scheduleContextRows(tx, and(inArray(annotations.id, ids), isNull(annotations.deletedAt))!, 0, reset) : 0;
      const nextCursor = batch.at(-1)?.id ?? upperBound;
      await tx
        .update(maintenance)
        .set({
          cursor: nextCursor,
          upperBound,
          algorithmVersion: CONTEXT_ALGORITHM_VERSION,
          completedAt: batch.length < 200 ? new Date() : null,
          leaseToken: token,
          leaseExpiresAt: new Date(Date.now() + 120_000),
        })
        .where(eq(maintenance.name, 'backfill'));
      return { scanned: batch.length, queued, cursor: nextCursor };
    });
  }

  async registerFile(bookFileId: number): Promise<void> {
    await this.db.insert(files).values({ bookFileId }).onConflictDoNothing();
  }

  async markFileChanged(bookFileId: number): Promise<void> {
    await this.db.update(files).set({ nextCheckAt: new Date() }).where(eq(files.bookFileId, bookFileId));
  }

  async markBookChanged(bookId: number): Promise<void> {
    await this.db
      .insert(maintenance)
      .values({ name: `book:${bookId}` })
      .onConflictDoUpdate({ target: maintenance.name, set: { cursor: 0, completedAt: null } });
  }

  async invalidateBookBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<Pick<typeof maintenance.$inferSelect, 'name' | 'cursor'>>(sql`
        select name, cursor from ${maintenance} where name like 'book:%' order by name limit 1 for update skip locked
      `);
      const state = result.rows[0];
      if (!state) return 0;
      const bookId = Number(state.name.slice(5));
      const batch = await tx
        .select({ id: annotations.id })
        .from(annotations)
        .where(and(eq(annotations.bookId, bookId), gt(annotations.id, state.cursor)))
        .orderBy(asc(annotations.id))
        .limit(200);
      const queued = batch.length
        ? await scheduleContextRows(
            tx,
            and(
              eq(annotations.bookId, bookId),
              inArray(
                annotations.id,
                batch.map((row) => row.id),
              ),
              isNull(annotations.deletedAt),
            )!,
            50,
          )
        : 0;
      if (batch.length < 200) await tx.delete(maintenance).where(eq(maintenance.name, state.name));
      else
        await tx
          .update(maintenance)
          .set({ cursor: batch.at(-1)!.id })
          .where(eq(maintenance.name, state.name));
      return queued;
    });
  }

  async claimFiles(token: string) {
    await this.db.insert(maintenance).values({ name: 'file-check' }).onConflictDoNothing();
    const result = await this.db.execute<
      Pick<typeof files.$inferSelect, 'bookFileId'> & Pick<typeof bookFiles.$inferSelect, 'absolutePath' | 'format'> & { databaseFingerprint: string }
    >(sql`
      with worker as (
        update ${maintenance} set lease_token = ${token}::uuid, lease_expires_at = now() + interval '2 minutes', completed_at = null
        where name = 'file-check' and (lease_expires_at is null or lease_expires_at < now()) returning name
      ), due as (select book_file_id from ${files} where next_check_at <= now() and (lease_expires_at is null or lease_expires_at < now())
        and exists (select 1 from worker) order by next_check_at, book_file_id limit 100 for update skip locked),
      claimed as (update ${files} set lease_token = ${token}::uuid, lease_expires_at = now() + interval '2 minutes'
        where book_file_id in (select book_file_id from due) returning book_file_id)
      select ${bookFiles.id} as "bookFileId", ${bookFiles.absolutePath} as "absolutePath", ${bookFiles.format}, ${contextDatabaseFileFingerprint} as "databaseFingerprint"
      from claimed join ${bookFiles} on ${bookFiles.id} = claimed.book_file_id
    `);
    return result.rows;
  }

  async recordFiles(token: string, snapshots: { bookFileId: number; fingerprint: string; databaseFingerprint?: string }[]): Promise<void> {
    if (snapshots.length) {
      const values = sql.join(
        snapshots.map((file) => sql`(${file.bookFileId}::int, ${file.fingerprint}::text, ${file.databaseFingerprint ?? null}::text)`),
        sql`,`,
      );
      await this.db.execute(sql`update ${files} set
        invalidation_pending = invalidation_pending or (${files.fingerprint} is not null and ${files.fingerprint} is distinct from snapshot.fingerprint),
        annotation_cursor = case when ${files.fingerprint} is distinct from snapshot.fingerprint then 0 else annotation_cursor end,
        fingerprint = snapshot.fingerprint, checked_at = now(),
        next_check_at = case when snapshot.database_fingerprint is not null and snapshot.database_fingerprint <> ${contextDatabaseFileFingerprint} then now() else now() + interval '1 day' end,
        lease_token = null, lease_expires_at = null
        from (values ${values}) as snapshot(book_file_id, fingerprint, database_fingerprint)
        join ${bookFiles} on ${bookFiles.id} = snapshot.book_file_id
        where ${files.bookFileId} = snapshot.book_file_id and ${files.leaseToken} = ${token}::uuid`);
    }
    await this.db
      .update(maintenance)
      .set({ cursor: snapshots.at(-1)?.bookFileId ?? 0, completedAt: snapshots.length ? null : new Date(), leaseToken: null, leaseExpiresAt: null })
      .where(and(eq(maintenance.name, 'file-check'), eq(maintenance.leaseToken, token)));
  }

  async getFile(bookFileId: number) {
    const [row] = await this.db
      .select({ id: bookFiles.id, absolutePath: bookFiles.absolutePath, format: bookFiles.format })
      .from(bookFiles)
      .where(eq(bookFiles.id, bookFileId))
      .limit(1);
    return row ?? null;
  }

  async recordFile(bookFileId: number, fingerprint: string, databaseFingerprint?: string): Promise<boolean> {
    const result = await this.db.execute<{ changed: boolean }>(sql`
      update ${files} set invalidation_pending = invalidation_pending or (fingerprint is not null and fingerprint is distinct from ${fingerprint}),
        annotation_cursor = case when fingerprint is distinct from ${fingerprint} then 0 else annotation_cursor end,
        fingerprint = ${fingerprint}, checked_at = now(), next_check_at = now() + interval '1 day',
        lease_token = null, lease_expires_at = null
      from ${bookFiles}
      where book_file_id = ${bookFileId} and ${bookFiles.id} = ${bookFileId}
        ${databaseFingerprint ? sql`and ${contextDatabaseFileFingerprint} = ${databaseFingerprint}` : sql``}
      returning invalidation_pending as changed
    `);
    return result.rows[0]?.changed ?? false;
  }

  async invalidateFileBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<Pick<typeof files.$inferSelect, 'bookFileId' | 'annotationCursor'>>(sql`
        select book_file_id as "bookFileId", annotation_cursor as "annotationCursor" from ${files}
        where invalidation_pending = true order by book_file_id limit 1 for update skip locked
      `);
      const file = result.rows[0];
      if (!file) return 0;
      const ids = await tx
        .select({ id: contexts.annotationId })
        .from(contexts)
        .where(and(eq(contexts.bookFileId, file.bookFileId), gt(contexts.annotationId, file.annotationCursor)))
        .orderBy(asc(contexts.annotationId))
        .limit(200);
      const queued = ids.length
        ? await scheduleContextRows(
            tx,
            and(
              inArray(
                annotations.id,
                ids.map((row) => row.id),
              ),
              isNull(annotations.deletedAt),
            )!,
            50,
            false,
          )
        : 0;
      await tx
        .update(files)
        .set({ annotationCursor: ids.at(-1)?.id ?? file.annotationCursor, invalidationPending: ids.length === 200 })
        .where(eq(files.bookFileId, file.bookFileId));
      return queued;
    });
  }

  async backlog(): Promise<number> {
    const result = await this.db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${contexts} where status in ('pending','processing') or (status = 'failed' and available_at is not null)`,
    );
    return result.rows[0]?.count ?? 0;
  }
}

export type AnnotationContextInput = Awaited<ReturnType<AnnotationContextRepository['getInputs']>>[number];
