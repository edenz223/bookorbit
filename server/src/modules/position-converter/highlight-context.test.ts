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
  it('uses the complete paragraph when it fits the shared budget', () => {
    const { chapter, cfi } = fixture('<p>Older sentence. Previous sentence. MARK. Next sentence! Later sentence.</p>', 'MARK.');
    expect(chapter.extract(cfi, 'MARK.')).toEqual({ before: 'Older sentence. Previous sentence. ', after: ' Next sentence! Later sentence.' });
  });

  it('shares 100 Unicode characters including truncation markers', () => {
    const before = '中😀'.repeat(35);
    const after = '🚀文'.repeat(35);
    const { chapter, cfi } = fixture(`<p>${before}MARK${after}。</p>`);
    const context = chapter.extract(cfi, 'MARK')!;
    expect(Array.from(context.before + context.after)).toHaveLength(100);
    expect(context.before.startsWith('…')).toBe(true);
    expect(context.after.endsWith('…')).toBe(true);
    expect(context.before.slice(1)).toBe(Array.from(before).slice(-49).join(''));
    expect(context.after.slice(0, -1)).toBe(Array.from(after).slice(0, 49).join(''));
  });

  it('stays within the chapter and preserves exact adjacency', () => {
    const { chapter, cfi } = fixture('<p>MARK, next.</p>');
    expect(chapter.extract(cfi, 'MARK')).toEqual({ before: '', after: ', next.' });
    const end = fixture('<p>previous: MARK</p>');
    expect(end.chapter.extract(end.cfi, 'MARK')).toEqual({ before: 'previous: ', after: '' });
  });

  it.each(['zh', 'en', 'invalid_locale'])('segments Chinese and mixed sentences with locale %s', (language) => {
    const { chapter, cfi } = fixture('<p>更早一句。上一句 English！MARK。下一句中文？更晚一句。</p>', 'MARK。', 0, language);
    expect(chapter.extract(cfi, 'MARK。')).toEqual({ before: '更早一句。上一句 English！', after: '下一句中文？更晚一句。' });
  });

  it('preserves paragraph, explicit and source line breaks', () => {
    const { chapter, cfi } = fixture('<p>Outside.</p><p>Previous line<br/>MARK.<br/>Next line.</p><p>Outside.</p>', 'MARK.');
    expect(chapter.extract(cfi, 'MARK.')).toEqual({ before: 'Previous line\n', after: '\nNext line.' });
    const source = fixture('<p>before\r\nMARK after\ncontinued</p>');
    expect(source.chapter.extract(source.cfi, 'MARK')).toEqual({ before: 'before\n', after: ' after\ncontinued' });
  });

  it('resolves cross-node, cross-paragraph ranges and Unicode/entities', () => {
    const { chapter, cfi } = fixture('<p>😀 before &amp; <em>selected</em></p><p>text after 🚀.</p>', 'selected text');
    expect(chapter.extract(cfi, 'selected\ntext')).toEqual({ before: '😀 before & ', after: ' after 🚀.' });
  });

  it('excludes non-reading elements without shifting the original CFI paths', () => {
    const { chapter, cfi } = fixture(
      '<p>before </p><script>secret script</script><style>secret style</style><noscript>secret fallback</noscript><template>secret template</template><p>MARK after</p>',
    );
    expect(chapter.extract(cfi, 'MARK')).toEqual({ before: '', after: ' after' });
  });

  it('uses the anchored occurrence and never searches for replacement text', () => {
    const { chapter, cfi } = fixture('<p>First MARK left.</p><p>Second MARK right.</p>', 'MARK', 1);
    expect(chapter.extract(cfi, 'MARK')).toEqual({ before: 'Second ', after: ' right.' });
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
