import assert from 'node:assert/strict';
import { test } from 'node:test';
import { label } from '../src/recent.mjs';

test('shows a file by the last part of its path', () => {
  assert.deepEqual([label('notes/2026/may.txt'), label('todo.txt')], ['may.txt', 'todo.txt']);
});
