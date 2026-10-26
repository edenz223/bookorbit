import { scheduleAnnotationContext } from './annotation-context.inputs';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { annotationPositions, annotations, AnnotationPosition, NewAnnotationPosition } from '../../db/schema';
import type { AnnotationPositionFormat } from './annotation.constants';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class AnnotationPositionRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async upsert(position: NewAnnotationPosition): Promise<AnnotationPosition> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(annotationPositions)
        .values(position)
        .onConflictDoUpdate({
          target: [annotationPositions.annotationId, annotationPositions.format],
          set: {
            pos0: sql`excluded.pos0`,
            pos1: sql`excluded.pos1`,
            status: sql`excluded.status`,
            converterVersion: sql`excluded.converter_version`,
            extras: sql`excluded.extras`,
            bookFileId: sql`excluded.book_file_id`,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (position.format === 'cfi') await scheduleAnnotationContext(tx, position.annotationId, position.userId);
      return row;
    });
  }

  async findByAnnotationIds(annotationIds: number[]): Promise<AnnotationPosition[]> {
    if (annotationIds.length === 0) return [];
    return this.db.select().from(annotationPositions).where(inArray(annotationPositions.annotationId, annotationIds));
  }

  async findByAnnotationId(annotationId: number, format?: AnnotationPositionFormat): Promise<AnnotationPosition[]> {
    const conditions = [eq(annotationPositions.annotationId, annotationId)];
    if (format) conditions.push(eq(annotationPositions.format, format));
    return this.db
      .select()
      .from(annotationPositions)
      .where(and(...conditions));
  }

  /** Active annotations of a book joined with their device xpointer position. */
  async findXPointerRowsForBook(
    userId: number,
    bookId: number,
    annotationIds?: number[],
  ): Promise<{ annotationId: number; text: string; pos0: string | null; pos1: string | null; bookFileId: number | null; status: string }[]> {
    return this.db
      .select({
        annotationId: annotations.id,
        text: annotations.text,
        pos0: annotationPositions.pos0,
        pos1: annotationPositions.pos1,
        bookFileId: annotationPositions.bookFileId,
        status: annotationPositions.status,
      })
      .from(annotations)
      .innerJoin(annotationPositions, and(eq(annotationPositions.annotationId, annotations.id), eq(annotationPositions.format, 'xpointer')))
      .where(
        and(
          eq(annotations.userId, userId),
          eq(annotationPositions.userId, userId),
          eq(annotations.bookId, bookId),
          isNull(annotations.deletedAt),
          annotationIds ? inArray(annotations.id, annotationIds) : undefined,
        ),
      );
  }

  async markPending(annotationId: number, format: AnnotationPositionFormat): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(annotationPositions)
        .set({ status: 'pending', updatedAt: sql`now()` })
        .where(and(eq(annotationPositions.annotationId, annotationId), eq(annotationPositions.format, format)))
        .returning({ userId: annotationPositions.userId });
      if (format === 'cfi' && rows[0]) await scheduleAnnotationContext(tx, annotationId, rows[0].userId);
    });
  }
}
