import { describe, expect, it } from 'vitest';

import { countAnnotationWords } from '@bookorbit/types';
import { HighlightContextWindow, highlightContextPolicy } from './highlight-context-window';

function extract(before: string, selected: string, after: string, language = 'en') {
  return new HighlightContextWindow(before + selected + after, language).extract(Array.from(before).length, Array.from(before + selected).length);
}

describe('paragraph context budget', () => {
  it.each([
    [1, 100, true],
    [3, 100, true],
    [4, 100, false],
    [12, 100, false],
    [13, 100, true],
    [30, 100, true],
    [31, 40, false],
    [60, 40, false],
    [61, 0, false],
    [75, 0, false],
    [76, 0, false],
  ])('selects the policy at %s words', (words, budget, expand) => {
    expect(highlightContextPolicy(words as number)).toMatchObject({ budget, expand });
  });

  it('counts lexical words, excluding punctuation and preserving multilingual segmentation', () => {
    expect(countAnnotationWords('one, two! three 😀')).toBe(3);
    expect(countAnnotationWords('阅读书籍，学习知识。')).toBeGreaterThan(1);
    expect(countAnnotationWords('one two', 'invalid_locale')).toBe(2);
  });

  it('completes only the containing sentence for 4 through 12 words', () => {
    expect(extract('Older sentence. Prefix ', 'one two three four', ' suffix. Next sentence.')).toEqual({
      before: '…Prefix ',
      after: ' suffix. …',
    });
  });

  it('adds only a small context for 31 through 60 words', () => {
    const result = extract('before '.repeat(30), 'word '.repeat(31), 'after '.repeat(30));
    expect(Array.from(result.before + result.after).length).toBeLessThanOrEqual(40);
  });

  it.each([61, 75, 76, 100])('adds no context at %s words', (words) => {
    expect(extract('Before. ', 'word '.repeat(words), ' After.')).toEqual({ before: '', after: '' });
  });
  it('keeps a complete short paragraph with original line breaks', () => {
    expect(extract('Previous.\n', 'MARK', '\nNext.')).toEqual({ before: 'Previous.\n', after: '\nNext.' });
  });

  it('expands whole sentences in both directions without exceeding the budget', () => {
    const before = 'Older sentence. '.repeat(10) + 'Previous. ';
    const after = ' Next. ' + 'Later sentence. '.repeat(10);
    const result = extract(before, 'MARK.', after);
    expect(result.before).toContain('Previous. ');
    expect(result.after).toContain(' Next. ');
    expect(result.before.startsWith('…Older sentence.')).toBe(true);
    expect(result.after.endsWith('sentence. …')).toBe(true);
    expect(Array.from(result.before + result.after).length).toBeLessThanOrEqual(100);
  });

  it('transfers unused budget to the longer side and cuts at word boundaries', () => {
    const result = extract('Hi ', 'MARK', ' longword'.repeat(30));
    expect(result.before).toBe('Hi ');
    expect(result.after.length).toBeGreaterThan(50);
    expect(result.after).toMatch(/(?:longword| )…$/);
    expect(Array.from(result.before + result.after).length).toBeLessThanOrEqual(100);
  });

  it('falls back to characters for one oversized word, preserving a long highlight', () => {
    const selected = 'H'.repeat(300);
    const result = extract('a'.repeat(120), selected, 'b'.repeat(120));
    expect(result).toEqual({ before: '…' + 'a'.repeat(49), after: 'b'.repeat(49) + '…' });
    expect(result.before + selected + result.after).toHaveLength(selected.length + 100);
  });

  it('does not mark paragraph boundaries as omitted content', () => {
    expect(extract('', 'MARK', '')).toEqual({ before: '', after: '' });
  });
});
