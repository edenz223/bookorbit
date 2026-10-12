import { createHash } from 'node:crypto';
import { stat } from 'fs/promises';
import type { AnnotationContext } from '@bookorbit/types';

import type { EpubFileSource } from './epub-dom.service';

const MAX_ENTRIES = 5000;
const MAX_BYTES = 8 * 1024 * 1024;

export async function highlightFileVersion(file: EpubFileSource): Promise<string | null> {
  try {
    const info = await stat(file.absolutePath);
    return JSON.stringify([file.bookFileId, file.absolutePath, file.format, info.mtimeMs, info.ctimeMs, info.size]);
  } catch {
    return null;
  }
}

export class HighlightContextCache {
  private readonly entries = new Map<string, { value: AnnotationContext | null; bytes: number }>();
  private bytes = 0;

  key(version: string, cfi: string, text: string): string {
    return `${version}:${createHash('sha256')
      .update(JSON.stringify([cfi, text]))
      .digest('hex')}`;
  }

  get(key: string): AnnotationContext | null | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: AnnotationContext | null): void {
    const bytes = key.length * 2 + ((value?.before.length ?? 0) + (value?.after.length ?? 0)) * 2 + 128;
    if (bytes > MAX_BYTES) return;
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
}
