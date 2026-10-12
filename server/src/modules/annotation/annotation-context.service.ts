import { Injectable } from '@nestjs/common';
import type { AnnotationItem } from '@bookorbit/types';

import { AnnotationContextRepository } from './annotation-context.repository';

@Injectable()
export class AnnotationContextService {
  constructor(private readonly repository: AnnotationContextRepository) {}

  async enrich<T extends Pick<AnnotationItem, 'id'>>(userId: number, items: T[]): Promise<(T & Pick<AnnotationItem, 'context'>)[]> {
    const rows = await this.repository.getStored(
      userId,
      items.map((item) => item.id),
    );
    const contexts = new Map(rows.map((row) => [row.annotationId, { before: row.before ?? '', after: row.after ?? '' }]));
    return items.map((item) => ({ ...item, context: contexts.get(item.id) ?? null }));
  }
}
