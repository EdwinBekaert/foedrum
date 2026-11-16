import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addScore, ranking, teams } from '../src/quiz.mjs';

const SCORES = [
  { team: 'Owls', points: 7 },
  { team: 'Quizzly Bears', points: 9 },
  { team: 'Owls', points: 6 },
];

test('adds a score at the end', () => {
  assert.deepEqual(addScore(SCORES, { team: 'Moths', points: 4 }).at(-1), {
    team: 'Moths',
    points: 4,
  });
});

test('lists each team once, in the order they first scored', () => {
  assert.deepEqual(teams(SCORES), ['Owls', 'Quizzly Bears']);
});

test('ranks the teams by their points over every round, the most first', () => {
  assert.deepEqual(ranking([{ team: 'Moths', points: 2 }, ...SCORES]), [
    { team: 'Owls', points: 13 },
    { team: 'Quizzly Bears', points: 9 },
    { team: 'Moths', points: 2 },
  ]);
});
