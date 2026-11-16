import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as shelf from '../../src/shelf.mjs';
import * as store from '../../src/store.mjs';

const BOOKS = [
  { title: 'Low Tide', author: 'Brel', tags: ['holiday', 'work'] },
  { title: 'Salt Roads', author: 'Vos' },
  { title: 'Grey Orchard', author: 'Lund', tags: ['holiday'] },
];

test("lists the books with a tag in the shelf's order", () => {
  assert.deepEqual(
    shelf.withTag(BOOKS, 'holiday').map((book) => book.title),
    ['Low Tide', 'Grey Orchard'],
  );
});

test('reads a shelf file whose books have tags or none', () => {
  assert.equal(store.parseShelf(JSON.stringify(BOOKS)).length, 3);
});

test('the list command with --tag lists only the books with that tag', () => {
  const file = fileURLToPath(new URL('./tagged-shelf.json', import.meta.url));
  writeFileSync(file, JSON.stringify(BOOKS));
  try {
    const output = execFileSync(
      process.execPath,
      ['src/cli.mjs', 'list', file, '--tag', 'holiday'],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
    assert.equal(lines.length, 2, output);
    assert.ok(lines[0].includes('Low Tide') && lines[1].includes('Grey Orchard'), output);
  } finally {
    rmSync(file, { force: true });
  }
});

test('docs/format.md lists tags as a field a book may leave out', () => {
  const page = readFileSync(new URL('../../docs/format.md', import.meta.url), 'utf8');
  const row = page.split(/\r?\n/).find((line) => line.startsWith('|') && line.includes('`tags`'));
  assert.ok(row, 'docs/format.md has no row for `tags`');
  assert.match(row, /\|\s*no\s*\|/i);
});
