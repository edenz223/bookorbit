import { and, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from '../../db/schema';

export const CONTEXT_ALGORITHM_VERSION = 1;
export const contextPosition = alias(schema.annotationPositions, 'context_position');
export const contextPdfPosition = alias(schema.annotationPositions, 'context_pdf_position');
export const contextFileId = sql<
  number | null
>`coalesce(${contextPosition.bookFileId}, ${contextPdfPosition.bookFileId}, ${schema.books.primaryFileId})`;
export const contextDatabaseFileFingerprint = sql<string>`md5(jsonb_build_array(${schema.bookFiles.absolutePath}, ${schema.bookFiles.format}, ${schema.bookFiles.fileHash}, ${schema.bookFiles.sizeBytes}::text, extract(epoch from ${schema.bookFiles.mtime})::text)::text)`;
export const contextFingerprint = sql<string>`md5(jsonb_build_array(
  ${schema.annotations.text}, ${contextPosition.pos0}, ${contextPosition.status}, ${schema.books.status},
  ${schema.bookFiles.id}, ${schema.bookFiles.absolutePath}, ${schema.bookFiles.format},
  ${schema.bookFiles.fileHash}, ${schema.bookFiles.sizeBytes}::text, extract(epoch from ${schema.bookFiles.mtime})::text,
  ${schema.annotationContextFiles.fingerprint}, ${CONTEXT_ALGORITHM_VERSION}::int
)::text)`;

export type ContextExecutor = Pick<NodePgDatabase<typeof schema>, 'execute'>;
export const contextSourceFrom = sql`
  from ${schema.annotations}
  join ${schema.books} on ${schema.books.id} = ${schema.annotations.bookId}
  left join ${schema.annotationPositions} as ${sql.identifier('context_position')} on ${contextPosition.annotationId} = ${schema.annotations.id} and ${contextPosition.userId} = ${schema.annotations.userId} and ${contextPosition.format} = 'cfi'
  left join ${schema.annotationPositions} as ${sql.identifier('context_pdf_position')} on ${contextPdfPosition.annotationId} = ${schema.annotations.id} and ${contextPdfPosition.userId} = ${schema.annotations.userId} and ${contextPdfPosition.format} = 'pdf'
  left join ${schema.bookFiles} on ${schema.bookFiles.id} = ${contextFileId} and ${schema.bookFiles.bookId} = ${schema.annotations.bookId}
  left join ${schema.annotationContextFiles} on ${schema.annotationContextFiles.bookFileId} = ${schema.bookFiles.id}
`;

export async function scheduleAnnotationContext(
  ex: ContextExecutor,
  annotationId: number,
  userId: number,
  priority = 50,
  force = false,
): Promise<void> {
  await scheduleContextRows(ex, and(eq(schema.annotations.id, annotationId), eq(schema.annotations.userId, userId))!, priority, force);
}

export async function scheduleContextRows(ex: ContextExecutor, filter: SQL, priority: number, force = false): Promise<number> {
  const result = await ex.execute(sql`
    insert into ${schema.annotationContexts} (annotation_id, user_id, book_file_id, input_fingerprint, algorithm_version, priority)
    select ${schema.annotations.id}, ${schema.annotations.userId}, ${schema.bookFiles.id}, ${contextFingerprint}, ${CONTEXT_ALGORITHM_VERSION}, ${priority}
    ${contextSourceFrom}
    where ${filter}
    on conflict (annotation_id) do update set
      status = 'pending', input_fingerprint = excluded.input_fingerprint, algorithm_version = excluded.algorithm_version,
      book_file_id = excluded.book_file_id, priority = excluded.priority, generation = annotation_contexts.generation + 1,
      before = null, after = null, reason = null, generated_at = null, attempt_count = 0,
      available_at = now(), lease_token = null, lease_expires_at = null, updated_at = now()
    where annotation_contexts.user_id = excluded.user_id and
      (${force} or annotation_contexts.input_fingerprint is distinct from excluded.input_fingerprint or annotation_contexts.algorithm_version <> excluded.algorithm_version)
    returning annotation_id
  `);
  return result.rowCount ?? 0;
}
