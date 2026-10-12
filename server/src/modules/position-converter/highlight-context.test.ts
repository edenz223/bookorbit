import { stat } from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HighlightContextChapter } from './highlight-context';
import { HighlightContextWindow } from './highlight-context-window';
import { collapsedRangeToCfi, parseChapterDocument } from './position-converter.core';
import { PositionConverterService, type HighlightContextSource } from './position-converter.service';

vi.mock('fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs/promises')>()), stat: vi.fn() }));

beforeEach(() => {
  vi.mocked(stat)
    .mockReset()
    .mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 100 } as never);
});

function fixture(body: string, text = 'MARK', occurrence = 0, language = 'en', chapterIndex = 0) {
  const doc = parseChapterDocument(`<html xml:lang="${language}"><head><title>excluded title</title></head><body>${body}</body></html>`);
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = doc.index.collapsed.indexOf(text, start + 1);
  const cpStart = Array.from(doc.index.collapsed.slice(0, start)).length;
  const cfi = collapsedRangeToCfi(doc, chapterIndex, cpStart, cpStart + Array.from(text).length)!;
  return { doc, cfi, chapter: new HighlightContextChapter(doc) };
}

describe('highlight context extraction', () => {
  it('does not segment the paragraph when a long highlight needs no context', () => {
    const text = 'word '.repeat(76).trim();
    const { chapter, cfi } = fixture(`<p>before ${text} after</p>`, text);
    const extract = vi.spyOn(HighlightContextWindow.prototype, 'extract');
    expect(chapter.extract(cfi, text)).toEqual({ before: '', after: '' });
    expect(extract).not.toHaveBeenCalled();
    extract.mockRestore();
  });
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
  it('serves repeated large pages without loading chapters or extracting ranges again', async () => {
    const doc = fixture('<p>before MARK after</p>').doc;
    const load = vi.fn().mockResolvedValue(doc);
    const epubDom = { createChapterLoader: vi.fn().mockResolvedValue(load) };
    const service = new PositionConverterService(epubDom as never);
    const extract = vi.spyOn(HighlightContextChapter.prototype, 'extract');
    const sources = Array.from({ length: 50 }, (_, chapterIndex) => ({
      annotationId: chapterIndex,
      bookFileId: 1,
      absolutePath: '/book.epub',
      format: 'epub',
      cfi: fixture('<p>before MARK after</p>', 'MARK', 0, 'en', chapterIndex).cfi,
      text: 'MARK',
    }));
    const first = await service.getHighlightContexts(sources);
    const second = await service.getHighlightContexts(sources);
    expect(second).toEqual(first);
    expect(load).toHaveBeenCalledTimes(50);
    expect(extract).toHaveBeenCalledTimes(50);
    expect(epubDom.createChapterLoader).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(2);
    extract.mockRestore();
  });

  it('invalidates results for edits, changed file versions and missing files', async () => {
    const load = vi.fn().mockResolvedValue(fixture('<p>before MARK after</p>').doc);
    const service = new PositionConverterService({ createChapterLoader: vi.fn().mockResolvedValue(load) } as never);
    const source = {
      annotationId: 1,
      bookFileId: 1,
      absolutePath: '/book.epub',
      format: 'epub',
      cfi: fixture('<p>before MARK after</p>').cfi,
      text: 'MARK',
    };
    expect((await service.getHighlightContexts([source])).get(1)).not.toBeNull();
    expect((await service.getHighlightContexts([{ ...source, text: 'changed text' }])).get(1)).toBeNull();
    expect(
      (await service.getHighlightContexts([{ ...source, cfi: fixture('<p>before MARK after</p>', 'before').cfi, text: 'before' }])).get(1),
    ).toEqual({ before: '', after: ' MARK after' });
    vi.mocked(stat).mockResolvedValue({ mtimeMs: 1, ctimeMs: 2, size: 101 } as never);
    await service.getHighlightContexts([source]);
    expect(load).toHaveBeenCalledTimes(4);
    vi.mocked(stat).mockRejectedValueOnce(new Error('missing file'));
    expect((await service.getHighlightContexts([source])).get(1)).toBeNull();
    expect(load).toHaveBeenCalledTimes(4);
  });

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
