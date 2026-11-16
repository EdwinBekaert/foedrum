import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as recent from '../../src/recent.mjs';

const openAll = (files) => files.reduce(recent.opened, []);

test('the file opened last comes first', () => {
  assert.deepEqual(openAll(['plan.txt', 'notes.txt']), ['notes.txt', 'plan.txt']);
});

test('a sixth file leaves out the one opened longest ago', () => {
  const kept = openAll(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']);
  assert.equal(kept.length, 5);
  assert.ok(!kept.includes('a.txt'), `${kept} still has a.txt`);
});

test('a file opened again comes first, once', () => {
  assert.deepEqual(openAll(['plan.txt', 'notes.txt', 'plan.txt']), ['plan.txt', 'notes.txt']);
});
