import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as posts from '../../src/posts.mjs';

test("a post's address is its title's words in lower case, joined by hyphens", () => {
  assert.equal(posts.slugOf('My first post'), 'my-first-post');
});

test('punctuation and extra spaces in a title give no extra hyphens', () => {
  assert.equal(posts.slugOf('  why tea? a guide, part 2 '), 'why-tea-a-guide-part-2');
});
