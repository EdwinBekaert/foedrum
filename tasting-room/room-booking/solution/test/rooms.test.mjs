import assert from 'node:assert/strict';
import { test } from 'node:test';
import { book } from '../src/rooms.mjs';

test('books a room for some hours', () => {
  assert.deepEqual(book([], { room: 'Attic', from: 9, to: 11 }), {
    ok: true,
    bookings: [{ room: 'Attic', from: 9, to: 11 }],
  });
});

test('refuses a room the office does not have', () => {
  assert.deepEqual(book([], { room: 'Cellar', from: 9, to: 11 }), {
    ok: false,
    code: 'UNKNOWN_ROOM',
  });
});

test('refuses hours that are not whole, or that end before they start', () => {
  for (const [from, to] of [
    [11, 9],
    [9, 9],
    [9.5, 11],
    [20, 25],
  ]) {
    assert.deepEqual(book([], { room: 'Attic', from, to }), { ok: false, code: 'BAD_HOURS' });
  }
});

test('refuses a room another booking holds for one of its hours, and books one that ends as it starts', () => {
  const day = [{ room: 'Attic', from: 9, to: 11 }];
  assert.deepEqual(book(day, { room: 'Attic', from: 10, to: 12 }), {
    ok: false,
    code: 'ROOM_TAKEN',
  });
  assert.equal(book(day, { room: 'Attic', from: 11, to: 12 }).ok, true);
});
