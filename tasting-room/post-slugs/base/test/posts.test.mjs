import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readingMinutes } from '../src/posts.mjs';

test('takes a minute for every 200 words begun, and at least one', () => {
  assert.deepEqual(
    [readingMinutes(''), readingMinutes('word '.repeat(200)), readingMinutes('word '.repeat(201))],
    [1, 1, 2],
  );
});
