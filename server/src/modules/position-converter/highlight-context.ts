import type { AnnotationContext } from '@bookorbit/types';

import { ChapterTextIndex, normalizeForSearch } from './chapter-text-index';
import { getDocumentElement } from './cfi.utils';
import { cfiRangeToCollapsed, type ChapterDocument } from './position-converter.core';

const EXCLUDED_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'head']);
const CONTEXT_WORDS = 50;

export class HighlightContextChapter {
  private readonly doc: ChapterDocument;
  private readonly segmenter: Intl.Segmenter;
  private readonly words: { start: number; end: number }[] = [];

  constructor(doc: ChapterDocument) {
    // Keep the original DOM so filtering non-reading text cannot shift CFI paths.
    this.doc = { root: doc.root, index: new ChapterTextIndex(doc.root, undefined, EXCLUDED_ELEMENTS) };
    const html = getDocumentElement(doc.root);
    const body = html?.children?.find((child) => child.name?.toLowerCase() === 'body');
    const language = body?.attribs?.['xml:lang'] || body?.attribs?.lang || html?.attribs?.['xml:lang'] || html?.attribs?.lang || 'zh';
    try {
      this.segmenter = new Intl.Segmenter(language, { granularity: 'word' });
    } catch {
      this.segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    }
    for (const part of this.segmenter.segment(this.doc.index.collapsed)) {
      if (part.isWordLike) this.words.push({ start: part.index, end: part.index + part.segment.length });
    }
  }

  extract(cfi: string, text: string): AnnotationContext | null {
    const range = cfiRangeToCollapsed(this.doc, cfi);
    if (!range || !normalizeForSearch(text)) return null;
    const selected = this.doc.index.extractCollapsed(range.startCp, range.endCp);
    if (normalizeForSearch(selected) !== normalizeForSearch(text)) return null;
    const start = this.doc.index.extractCollapsed(0, range.startCp).length;
    const end = start + selected.length;
    const beforeCount = this.lowerBound(start, 'start');
    const afterIndex = this.lowerBound(end + 1, 'end');
    const beforeStart = beforeCount > CONTEXT_WORDS ? this.words[beforeCount - CONTEXT_WORDS].start : 0;
    const afterEnd = this.words[afterIndex + CONTEXT_WORDS]?.start ?? this.doc.index.collapsed.length;
    return {
      before: this.doc.index.collapsed.slice(beforeStart, start).replace(/\s+/g, ' '),
      after: this.doc.index.collapsed.slice(end, afterEnd).replace(/\s+/g, ' '),
    };
  }

  private lowerBound(offset: number, field: 'start' | 'end'): number {
    let low = 0;
    let high = this.words.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.words[middle][field] < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
