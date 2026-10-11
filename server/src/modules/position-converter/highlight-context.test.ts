import { describe, expect, it, vi } from 'vitest';

import { HighlightContextChapter } from './highlight-context';
import { collapsedRangeToCfi, parseChapterDocument } from './position-converter.core';
import { PositionConverterService, type HighlightContextSource } from './position-converter.service';

function fixture(body: string, text = 'MARK', occurrence = 0, language = 'en', chapterIndex = 0) {
  const doc = parseChapterDocument(`<html xml:lang="${language}"><head><title>excluded title</title></head><body>${body}</body></html>`);
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = doc.index.collapsed.indexOf(text, start + 1);
  const cpStart = Array.from(doc.index.collapsed.slice(0, start)).length;
  const cfi = collapsedRangeToCfi(doc, chapterIndex, cpStart, cpStart + Array.from(text).length)!;
  return { doc, cfi, chapter: new HighlightContextChapter(doc) };
}

describe('highlight context extraction', () => {
  it('keeps the nearest 50 words on each side, including punctuation', () => {
    const before = Array.from({ length: 60 }, (_, i) => `before${i},`).join(' ');
    const after = Array.from({ length: 60 }, (_, i) => `after${i}!`).join(' ');
    const { chapter, cfi } = fixture(`<p>${before} MARK ${after}</p>`);
    expect(chapter.extract(cfi, 'MARK')).toEqual({
      before: `${Array.from({ length: 50 }, (_, i) => `before${i + 10},`).join(' ')} `,
      after: ` ${Array.from({ length: 50 }, (_, i) => `after${i}!`).join(' ')} `,
    });
  });

  it('stays within the chapter and preserves exact adjacency', () => {
    const { chapter, cfi } = fixture('<p>MARK, next.</p>');
    expect(chapter.extract(cfi, 'MARK')).toEqual({ before: '', after: ', next.' });
    const end = fixture('<p>previous: MARK</p>');
    expect(end.chapter.extract(end.cfi, 'MARK')).toEqual({ before: 'previous: ', after: '' });
  });

  it.each(['zh', 'en', 'invalid_locale'])('segments Chinese and mixed text with locale %s', (language) => {
    const before = '阅读书籍，学习知识。'.repeat(30);
    const after = '中文 English 世界。'.repeat(30);
    const { chapter, cfi } = fixture(`<p>${before}MARK${after}</p>`, 'MARK', 0, language);
    const context = chapter.extract(cfi, 'MARK')!;
    const segmenter = new Intl.Segmenter(language === 'invalid_locale' ? 'zh' : language, { granularity: 'word' });
    expect(Array.from(segmenter.segment(context.before)).filter((part) => part.isWordLike)).toHaveLength(50);
    expect(Array.from(segmenter.segment(context.after)).filter((part) => part.isWordLike)).toHaveLength(50);
    expect(before.endsWith(context.before)).toBe(true);
    expect(after.startsWith(context.after)).toBe(true);
  });

  it('resolves cross-node, cross-paragraph ranges and Unicode/entities', () => {
    const { chapter, cfi } = fixture('<p>😀 before &amp; <em>selected</em></p><p>text after 🚀.</p>', 'selected text');
    expect(chapter.extract(cfi, 'selected\ntext')).toEqual({ before: '😀 before & ', after: ' after 🚀.' });
  });

  it('excludes non-reading elements without shifting the original CFI paths', () => {
    const { chapter, cfi } = fixture(
      '<p>before </p><script>secret script</script><style>secret style</style><noscript>secret fallback</noscript><template>secret template</template><p>MARK after</p>',
    );
    expect(chapter.extract(cfi, 'MARK')).toEqual({ before: 'before ', after: ' after' });
  });

  it('uses the anchored occurrence and never searches for replacement text', () => {
    const { chapter, cfi } = fixture('<p>first MARK left.</p><p>second MARK right.</p>', 'MARK', 1);
    expect(chapter.extract(cfi, 'MARK')).toEqual({ before: 'first MARK left. second ', after: ' right.' });
    expect(chapter.extract(cfi, 'different text')).toBeNull();
    expect(chapter.extract('invalid', 'MARK')).toBeNull();
    expect(chapter.extract(cfi, '')).toBeNull();
  });
});

describe('highlight context batching', () => {
  it('reuses chapters and file loaders, limits concurrency to four and isolates failures', async () => {
    let active = 0;
    let peak = 0;
    const load = vi.fn(async (index: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (index === 4) throw new Error('missing chapter');
      return fixture('<p>before MARK after</p>').doc;
    });
    const epubDom = { createChapterLoader: vi.fn().mockResolvedValue(load) };
    const service = new PositionConverterService(epubDom as never);
    const sources: HighlightContextSource[] = Array.from({ length: 8 }, (_, index) => ({
      annotationId: index,
      bookFileId: 1,
      absolutePath: '/book.epub',
      format: 'epub',
      cfi: fixture('<p>before MARK after</p>', 'MARK', 0, 'en', index).cfi,
      text: 'MARK',
    }));
    sources.push({ ...sources[0], annotationId: 8 });
    sources.push({ ...sources[0], annotationId: 9, cfi: 'invalid' });
    sources.push({ ...sources[0], annotationId: 10, format: 'pdf' });
    sources.push({ ...sources[0], annotationId: 11, text: 'mismatch' });
    const result = await service.getHighlightContexts(sources);
    expect(epubDom.createChapterLoader).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(8);
    expect(peak).toBe(4);
    expect(result.get(0)).toEqual({ before: 'before ', after: ' after' });
    expect(result.get(8)).toEqual(result.get(0));
    for (const id of [4, 9, 10, 11]) expect(result.get(id)).toBeNull();
  });

  it('returns null when the source file or chapter is unavailable', async () => {
    const source = { annotationId: 1, bookFileId: 1, absolutePath: '/missing.epub', format: 'epub', cfi: fixture('<p>MARK</p>').cfi, text: 'MARK' };
    for (const loader of [vi.fn().mockResolvedValue(null), vi.fn().mockRejectedValue(new Error('missing'))]) {
      const service = new PositionConverterService({ createChapterLoader: vi.fn().mockResolvedValue(loader) } as never);
      expect((await service.getHighlightContexts([source])).get(1)).toBeNull();
    }
  });
});
