import { describe, expect, it } from 'vitest';

import { HighlightContextCache } from './highlight-context-cache';

describe('bounded highlight result cache', () => {
  it('distinguishes misses from cached failures and includes both CFI and original text', () => {
    const cache = new HighlightContextCache();
    const key = cache.key('version', 'cfi', 'text');
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, null);
    expect(cache.get(key)).toBeNull();
    expect(cache.get(cache.key('version', 'different cfi', 'text'))).toBeUndefined();
    expect(cache.get(cache.key('version', 'cfi', 'edited text'))).toBeUndefined();
    expect(cache.get(cache.key('changed file version', 'cfi', 'text'))).toBeUndefined();
  });

  it('evicts the least recently used result at the entry limit', () => {
    const cache = new HighlightContextCache();
    for (let i = 0; i < 5000; i++) cache.set(`${i}`, null);
    cache.get('0');
    cache.set('5000', null);
    expect(cache.get('0')).toBeNull();
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('5000')).toBeNull();
  });

  it('enforces a byte limit and ignores oversized entries', () => {
    const cache = new HighlightContextCache();
    cache.set('first', { before: 'x'.repeat(2500000), after: '' });
    cache.set('second', { before: 'y'.repeat(2500000), after: '' });
    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('second')).not.toBeUndefined();
    cache.set('oversized', { before: 'x'.repeat(5000000), after: '' });
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.get('second')).not.toBeUndefined();
  });
});
