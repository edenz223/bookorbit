import { EventEmitter } from 'node:events';

export const bookFileEvents = new EventEmitter();
export const BOOK_FILE_CHANGED = 'book-file-changed';
export const BOOK_CONTEXT_CHANGED = 'book-context-changed';

export function notifyBookFileChanged(bookFileId: number): void {
  bookFileEvents.emit(BOOK_FILE_CHANGED, bookFileId);
}

export function notifyBookContextsChanged(bookId: number): void {
  bookFileEvents.emit(BOOK_CONTEXT_CHANGED, bookId);
}
