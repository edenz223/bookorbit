import { Injectable } from '@nestjs/common';
import type { AnnotationItem } from '@bookorbit/types';

import { PositionConverterService } from '../position-converter/position-converter.service';
import { AnnotationRepository } from './annotation.repository';

@Injectable()
export class AnnotationContextService {
  constructor(
    private readonly annotationRepo: AnnotationRepository,
    private readonly positionConverter: PositionConverterService,
  ) {}

  async enrich<T extends Pick<AnnotationItem, 'id'>>(userId: number, items: T[]): Promise<(T & Pick<AnnotationItem, 'context'>)[]> {
    const sources = await this.annotationRepo.findContextSources(
      userId,
      items.map((item) => item.id),
    );
    const contexts = await this.positionConverter.getHighlightContexts(
      sources.flatMap((source) => (source.cfi ? [{ ...source, cfi: source.cfi }] : [])),
    );
    return items.map((item) => ({ ...item, context: contexts.get(item.id) ?? null }));
  }
}
