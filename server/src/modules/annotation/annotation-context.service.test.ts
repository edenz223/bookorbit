import { describe, expect, it, vi } from 'vitest';
import { AnnotationContextService } from './annotation-context.service';

describe('AnnotationContextService', () => {
  it('queries only this user and page, retaining the original text and falling back for unsupported items', async () => {
    const repo = { getStored: vi.fn().mockResolvedValue([{ annotationId: 1, before: 'before ', after: ' after' }]) };
    const service = new AnnotationContextService(repo as never);
    const items = [
      { id: 1, text: 'quote' },
      { id: 2, text: 'PDF quote' },
    ];
    const result = await service.enrich(42, items);
    expect(repo.getStored).toHaveBeenCalledWith(42, [1, 2]);
    expect(result).toEqual([
      { ...items[0], context: { before: 'before ', after: ' after' } },
      { ...items[1], context: null },
    ]);
    expect(items[0]).not.toHaveProperty('context');
  });
});
