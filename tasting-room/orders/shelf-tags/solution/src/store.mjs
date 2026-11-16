// The only module that reads and writes shelf files (CLAUDE.md); their format is docs/format.md.

import { readFileSync, writeFileSync } from 'node:fs';

const FIELDS = ['title', 'author', 'read', 'tags'];

/** The books of a shelf file's `text`, each checked against docs/format.md. */
export function parseShelf(text) {
  const books = JSON.parse(text);
  if (!Array.isArray(books)) throw new Error('a shelf file is a list of books');
  for (const book of books) {
    for (const field of ['title', 'author']) {
      if (typeof book?.[field] !== 'string' || book[field] === '') {
        throw new Error(`a book has no ${field}`);
      }
    }
    if (book.read !== undefined && typeof book.read !== 'boolean') {
      throw new Error(`${book.title}: read is not true or false`);
    }
    const tagsValid =
      Array.isArray(book.tags) && book.tags.every((tag) => typeof tag === 'string' && tag !== '');
    if (book.tags !== undefined && !tagsValid) {
      throw new Error(`${book.title}: tags is not a list of words`);
    }
    const unknown = Object.keys(book).filter((field) => !FIELDS.includes(field));
    if (unknown.length > 0) throw new Error(`${book.title}: unknown field ${unknown.join(', ')}`);
  }
  return books;
}

/** The books of the shelf file at `file`. */
export function load(file) {
  return parseShelf(readFileSync(file, 'utf8'));
}

/** Writes `books` to the shelf file at `file`. */
export function save(file, books) {
  writeFileSync(file, `${JSON.stringify(books, null, 2)}\n`);
}
