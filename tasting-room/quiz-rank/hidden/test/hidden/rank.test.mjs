import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('the rank command prints one team a line, the most points first', () => {
  const file = fileURLToPath(new URL('./rank-night.json', import.meta.url));
  writeFileSync(
    file,
    JSON.stringify([
      { team: 'Moths', points: 4 },
      { team: 'Owls', points: 7 },
    ]),
  );
  try {
    const output = execFileSync(process.execPath, ['src/cli.mjs', 'rank', file], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 30_000,
    });
    const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
    assert.equal(lines.length, 2, output);
    assert.ok(lines[0].includes('Owls') && lines[0].includes('7'), output);
    assert.ok(lines[1].includes('Moths') && lines[1].includes('4'), output);
  } finally {
    rmSync(file, { force: true });
  }
});

test('docs/commands.md lists the rank command', () => {
  const page = readFileSync(new URL('../../docs/commands.md', import.meta.url), 'utf8');
  const row = page.split(/\r?\n/).find((line) => line.startsWith('|') && line.includes('`rank'));
  assert.ok(row, 'docs/commands.md has no row for `rank`');
});
