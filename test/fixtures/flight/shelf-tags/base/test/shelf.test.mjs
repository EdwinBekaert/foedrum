import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBook } from '../src/shelf.mjs';
import { parseShelf } from '../src/store.mjs';

test('adds a book at the end', () => {
  const books = addBook([{ title: 'Low Tide', author: 'Brel' }], {
    title: 'Salt Roads',
    author: 'Vos',
  });
  assert.deepEqual(
    books.map((book) => book.title),
    ['Low Tide', 'Salt Roads'],
  );
});

test('reads a shelf file with a book read and one not', () => {
  const text =
    '[{"title":"Low Tide","author":"Brel","read":true},{"title":"Salt Roads","author":"Vos"}]';
  assert.equal(parseShelf(text).length, 2);
});

test('refuses a field the format does not list', () => {
  assert.throws(() => parseShelf('[{"title":"Low Tide","author":"Brel","pages":200}]'), /pages/);
});
