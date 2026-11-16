import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as quiz from '../../src/quiz.mjs';

const SCORES = [
  { team: 'Moths', points: 5 },
  { team: 'Owls', points: 7 },
  { team: 'Quizzly Bears', points: 9 },
  { team: 'Owls', points: 6 },
  { team: 'Moths', points: 3 },
];

test('ranks the teams by their points over every round, the most first', () => {
  assert.deepEqual(quiz.ranking(SCORES), [
    { team: 'Owls', points: 13 },
    { team: 'Quizzly Bears', points: 9 },
    { team: 'Moths', points: 8 },
  ]);
});

test('docs/commands.md lists the rank command', () => {
  const page = readFileSync(new URL('../../docs/commands.md', import.meta.url), 'utf8');
  const row = page.split(/\r?\n/).find((line) => line.startsWith('|') && line.includes('`rank'));
  assert.ok(row, 'docs/commands.md has no row for `rank`');
});
