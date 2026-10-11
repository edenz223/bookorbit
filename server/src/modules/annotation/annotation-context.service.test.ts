import { describe, expect, it, vi } from 'vitest';
import { AnnotationContextService } from './annotation-context.service';

describe('AnnotationContextService', () => {
  it('queries only this user and page, retaining the original text and falling back for unsupported items', async () => {
    const sources = [{ annotationId: 1, bookFileId: 7, text: 'quote', cfi: 'cfi' }];
    const repo = { findContextSources: vi.fn().mockResolvedValue(sources) };
    const converter = { getHighlightContexts: vi.fn().mockResolvedValue(new Map([[1, { before: 'before ', after: ' after' }]])) };
    const service = new AnnotationContextService(repo as never, converter as never);
    const items = [
      { id: 1, text: 'quote' },
      { id: 2, text: 'PDF quote' },
    ];
    const result = await service.enrich(42, items);
    expect(repo.findContextSources).toHaveBeenCalledWith(42, [1, 2]);
    expect(converter.getHighlightContexts).toHaveBeenCalledWith(sources);
    expect(result).toEqual([
      { ...items[0], context: { before: 'before ', after: ' after' } },
      { ...items[1], context: null },
    ]);
    expect(items[0]).not.toHaveProperty('context');
  });
});
