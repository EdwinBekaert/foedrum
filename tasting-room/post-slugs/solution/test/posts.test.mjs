import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readingMinutes, slugOf } from '../src/posts.mjs';

test('takes a minute for every 200 words begun, and at least one', () => {
  assert.deepEqual(
    [readingMinutes(''), readingMinutes('word '.repeat(200)), readingMinutes('word '.repeat(201))],
    [1, 1, 2],
  );
});

test("makes a post's address from its title's words", () => {
  assert.equal(slugOf('Ten Teas for 2026'), 'ten-teas-for-2026');
  assert.equal(slugOf('Tea, again!'), 'tea-again');
  assert.equal(slugOf('Café crème'), 'café-crème');
});
