import { countAnnotationWords, type AnnotationContext } from '@bookorbit/types';

import { ChapterTextIndex, normalizeForSearch } from './chapter-text-index';
import { getDocumentElement, type CfiNode } from './cfi.utils';
import { HighlightContextWindow } from './highlight-context-window';
import { cfiRangeToCollapsed, type ChapterDocument } from './position-converter.core';

const EXCLUDED_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'head']);
const PARAGRAPH_ELEMENTS = new Set(['p', 'li', 'blockquote', 'pre', 'div', 'section', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body']);
const MAX_WINDOWS = 32;
const MAX_WINDOW_CHARACTERS = 200000;

function paragraphOf(node: CfiNode): CfiNode {
  let current: CfiNode | null | undefined = node;
  while (current?.parent && !PARAGRAPH_ELEMENTS.has(current.name?.toLowerCase() ?? '')) current = current.parent;
  return current ?? node;
}

export class HighlightContextChapter {
  private readonly doc: ChapterDocument;
  private readonly language: string;
  private readonly paragraphs = new Map<CfiNode, { start: number; end: number }>();
  private readonly windows = new Map<string, { window: HighlightContextWindow; characters: number }>();
  private windowCharacters = 0;

  constructor(doc: ChapterDocument) {
    // Keep the original DOM so filtering non-reading text cannot shift CFI paths.
    this.doc = { root: doc.root, index: new ChapterTextIndex(doc.root, undefined, EXCLUDED_ELEMENTS, true) };
    const html = getDocumentElement(doc.root);
    const body = html?.children?.find((child) => child.name?.toLowerCase() === 'body');
    const language = body?.attribs?.['xml:lang'] || body?.attribs?.lang || html?.attribs?.['xml:lang'] || html?.attribs?.lang || 'zh';
    try {
      this.language = new Intl.Segmenter(language).resolvedOptions().locale;
    } catch {
      this.language = 'zh';
    }
    for (const run of this.doc.index.runs) {
      if (!run.collapsedLength) continue;
      const owner = paragraphOf(run.parent);
      const previous = this.paragraphs.get(owner);
      this.paragraphs.set(owner, {
        start: Math.min(previous?.start ?? run.collapsedStart, run.collapsedStart),
        end: Math.max(previous?.end ?? 0, run.collapsedStart + run.collapsedLength),
      });
    }
  }

  extract(cfi: string, text: string): AnnotationContext | null {
    const range = cfiRangeToCollapsed(this.doc, cfi);
    if (!range || !normalizeForSearch(text)) return null;
    const selected = this.doc.index.extractCollapsed(range.startCp, range.endCp);
    if (normalizeForSearch(selected) !== normalizeForSearch(text)) return null;
    if (countAnnotationWords(text, this.language, 61) > 60) return { before: '', after: '' };
    const first = this.doc.index.startPointFromCollapsed(range.startCp);
    const last = this.doc.index.endPointFromCollapsed(range.endCp);
    if (!first || !last) return null;
    const firstParagraph = this.paragraphs.get(paragraphOf(first.node));
    const lastParagraph = this.paragraphs.get(paragraphOf(last.node));
    if (!firstParagraph || !lastParagraph) return null;
    const start = Math.min(firstParagraph.start, range.startCp);
    const end = Math.max(lastParagraph.end, range.endCp);
    const key = `${start}:${end}`;
    const cached = this.windows.get(key);
    let window: HighlightContextWindow;
    if (cached) {
      this.windows.delete(key);
      this.windows.set(key, cached);
      window = cached.window;
    } else {
      const paragraph = this.doc.index.extractCollapsed(start, end);
      window = new HighlightContextWindow(paragraph, this.language);
      if (paragraph.length <= MAX_WINDOW_CHARACTERS) {
        this.windows.set(key, { window, characters: paragraph.length });
        this.windowCharacters += paragraph.length;
        while (this.windows.size > MAX_WINDOWS || this.windowCharacters > MAX_WINDOW_CHARACTERS) {
          const oldest = this.windows.keys().next().value!;
          this.windowCharacters -= this.windows.get(oldest)!.characters;
          this.windows.delete(oldest);
        }
      }
    }
    return window.extract(range.startCp - start, range.endCp - start);
  }
}
