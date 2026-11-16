import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as shelf from '../../src/shelf.mjs';
import * as store from '../../src/store.mjs';

const BOOKS = [
  { title: 'Low Tide', author: 'Brel', tags: ['holiday', 'work'] },
  { title: 'Salt Roads', author: 'Vos' },
  { title: 'Grey Orchard', author: 'Lund', tags: ['holiday'] },
];

test("lists the books with a tag in the shelf's order", () => {
  assert.deepEqual(
    shelf.withTag(BOOKS, 'holiday').map((book) => book.title),
    ['Low Tide', 'Grey Orchard'],
  );
});

test('reads a shelf file whose books have tags or none', () => {
  assert.equal(store.parseShelf(JSON.stringify(BOOKS)).length, 3);
});

test('docs/format.md lists tags as a field a book may leave out', () => {
  const page = readFileSync(new URL('../../docs/format.md', import.meta.url), 'utf8');
  const row = page.split(/\r?\n/).find((line) => line.startsWith('|') && line.includes('`tags`'));
  assert.ok(row, 'docs/format.md has no row for `tags`');
  assert.match(row, /\|\s*no\s*\|/i);
});
