import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as rooms from '../../src/rooms.mjs';

const DAY = [{ room: 'Garden', from: 10, to: 12 }];

test('refuses a room another booking holds at the same time, with ROOM_TAKEN', () => {
  assert.deepEqual(rooms.book(DAY, { room: 'Garden', from: 11, to: 13 }), {
    ok: false,
    code: 'ROOM_TAKEN',
  });
});

test('books another room at the same time, and the same room at other hours', () => {
  assert.deepEqual(rooms.book(DAY, { room: 'Library', from: 11, to: 13 }), {
    ok: true,
    bookings: [...DAY, { room: 'Library', from: 11, to: 13 }],
  });
  assert.deepEqual(rooms.book(DAY, { room: 'Garden', from: 14, to: 16 }), {
    ok: true,
    bookings: [...DAY, { room: 'Garden', from: 14, to: 16 }],
  });
});

test('docs/errors.md lists ROOM_TAKEN', () => {
  const page = readFileSync(new URL('../../docs/errors.md', import.meta.url), 'utf8');
  const row = page
    .split(/\r?\n/)
    .find((line) => line.startsWith('|') && line.includes('`ROOM_TAKEN`'));
  assert.ok(row, 'docs/errors.md has no row for `ROOM_TAKEN`');
});
