import assert from 'node:assert/strict';
import { test } from 'node:test';
import { label, opened } from '../src/recent.mjs';

test('shows a file by the last part of its path', () => {
  assert.deepEqual([label('notes/2026/may.txt'), label('todo.txt')], ['may.txt', 'todo.txt']);
});

test('keeps the five files opened most recently, newest first', () => {
  const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'c.txt'];
  assert.deepEqual(files.reduce(opened, []), ['c.txt', 'f.txt', 'e.txt', 'd.txt', 'b.txt']);
});
