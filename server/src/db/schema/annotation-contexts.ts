import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './auth';
import { bookFiles } from './books';
import { annotations } from './reader';

export const annotationContexts = pgTable(
  'annotation_contexts',
  {
    annotationId: integer('annotation_id')
      .primaryKey()
      .references(() => annotations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookFileId: integer('book_file_id').references(() => bookFiles.id, { onDelete: 'set null' }),
    inputFingerprint: varchar('input_fingerprint', { length: 32 }),
    algorithmVersion: integer('algorithm_version').notNull().default(1),
    status: varchar('status', { length: 16 }).$type<'pending' | 'processing' | 'ready' | 'unavailable' | 'failed'>().notNull().default('pending'),
    before: text('before'),
    after: text('after'),
    reason: varchar('reason', { length: 64 }),
    priority: integer('priority').notNull().default(50),
    generation: integer('generation').notNull().default(1),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('annotation_contexts_user_page_idx').on(t.userId, t.annotationId),
    index('annotation_contexts_pending_idx')
      .on(t.priority.desc(), t.availableAt, t.annotationId)
      .where(sql`${t.status} in ('pending', 'failed') and ${t.availableAt} is not null`),
    index('annotation_contexts_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'processing'`),
    index('annotation_contexts_file_idx').on(t.bookFileId, t.annotationId),
    check('annotation_contexts_status_chk', sql`${t.status} in ('pending', 'processing', 'ready', 'unavailable', 'failed')`),
  ],
);

export const annotationContextFiles = pgTable(
  'annotation_context_files',
  {
    bookFileId: integer('book_file_id')
      .primaryKey()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    fingerprint: varchar('fingerprint', { length: 64 }),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    invalidationPending: boolean('invalidation_pending').notNull().default(false),
    annotationCursor: integer('annotation_cursor').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  },
  (t) => [index('annotation_context_files_due_idx').on(t.nextCheckAt, t.bookFileId)],
);

export const annotationContextMaintenance = pgTable('annotation_context_maintenance', {
  name: varchar('name', { length: 32 }).primaryKey(),
  cursor: integer('cursor').notNull().default(0),
  upperBound: integer('upper_bound'),
  algorithmVersion: integer('algorithm_version').notNull().default(1),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
