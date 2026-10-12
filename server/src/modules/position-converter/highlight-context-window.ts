import { countAnnotationWords, type AnnotationContext } from '@bookorbit/types';

export function highlightContextPolicy(words: number) {
  if (words <= 3) return { budget: 100, expand: true, wholeParagraph: true };
  if (words <= 12) return { budget: 100, expand: false, wholeParagraph: false };
  if (words <= 30) return { budget: 100, expand: true, wholeParagraph: true };
  if (words <= 60) return { budget: 40, expand: false, wholeParagraph: false };
  return { budget: 0, expand: false, wholeParagraph: false };
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export class HighlightContextWindow {
  private readonly characters: string[];
  private readonly sentences: number[];
  private readonly words: number[];

  constructor(
    text: string,
    private readonly language: string,
  ) {
    this.characters = Array.from(text);
    const cpByOffset = new Int32Array(text.length + 1);
    let offset = 0;
    this.characters.forEach((character, index) => {
      cpByOffset[offset] = index;
      offset += character.length;
    });
    cpByOffset[text.length] = this.characters.length;
    const normalized = text.replace(/\n/g, ' ');
    // Keep sentence offsets aligned with the display text while retaining its line breaks.
    this.sentences = Array.from(new Intl.Segmenter(language, { granularity: 'sentence' }).segment(normalized), (part) => cpByOffset[part.index]);
    this.sentences.push(this.characters.length);
    this.words = [0];
    for (const part of new Intl.Segmenter(language, { granularity: 'word' }).segment(normalized)) {
      if (part.isWordLike) this.words.push(cpByOffset[part.index], cpByOffset[part.index + part.segment.length]);
    }
    this.words.push(this.characters.length);
  }

  extract(start: number, end: number): AnnotationContext {
    const policy = highlightContextPolicy(countAnnotationWords(this.characters.slice(start, end).join(''), this.language));
    if (!policy.budget) return { before: '', after: '' };
    const length = this.characters.length;
    if (policy.wholeParagraph && start + length - end <= policy.budget) return this.context(0, start, end, length);
    let first = Math.max(0, upperBound(this.sentences, start) - 1);
    let last = upperBound(this.sentences, end - 1);
    let left = this.sentences[first];
    let right = this.sentences[last];
    const cost = (from: number, to: number) => start - from + to - end + Number(from > 0) + Number(to < length);

    if (cost(left, right) > policy.budget) {
      const available = policy.budget - 2;
      const before = start - left;
      const after = right - end;
      let beforeBudget = Math.min(before, Math.floor(available / 2));
      const afterBudget = Math.min(after, available - beforeBudget);
      beforeBudget = Math.min(before, available - afterBudget);
      left = this.cut(start - beforeBudget, start, true);
      right = this.cut(end, end + afterBudget, false);
    } else if (policy.expand) {
      while (true) {
        const canLeft = first > 0 && cost(this.sentences[first - 1], right) <= policy.budget;
        const canRight = last < this.sentences.length - 1 && cost(left, this.sentences[last + 1]) <= policy.budget;
        if (!canLeft && !canRight) break;
        if (canLeft && (!canRight || start - left <= right - end)) left = this.sentences[--first];
        else right = this.sentences[++last];
      }
    }
    return this.context(left, start, end, right);
  }

  private cut(from: number, to: number, before: boolean): number {
    for (const boundaries of [this.sentences, this.words]) {
      const index = before ? upperBound(boundaries, from - 1) : upperBound(boundaries, to) - 1;
      const boundary = boundaries[index];
      if (boundary != null && boundary >= from && boundary <= to && (before ? boundary < to : boundary > from)) return boundary;
    }
    return before ? from : to;
  }

  private context(left: number, start: number, end: number, right: number): AnnotationContext {
    return {
      before: (left > 0 ? '…' : '') + this.characters.slice(left, start).join(''),
      after: this.characters.slice(end, right).join('') + (right < this.characters.length ? '…' : ''),
    };
  }
}
