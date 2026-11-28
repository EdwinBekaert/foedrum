// The V8 coverage of real node processes (#1176, ADR 0431, ADR 0303): each process started on a test
// file writes its record in NODE_V8_COVERAGE's folder, and the first script of the tree it compiled
// that the reports place a test in must be that file. A unit test starts no process (ADR 0021); the records written by hand are
// read in test/unit/node-coverage.test.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { reachOf } from '../../src/checks/mutant-reach.ts';
import { readNodeCoverage } from '../../src/checks/node-coverage.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
let tree: string;
let folder: string;

beforeEach(() => {
  dir = makeTempDir('node-coverage');
  tree = join(dir.path, 'tree');
  folder = join(tree, '.foedrum', 'tmp', 'node-v8-coverage');
  mkdirSync(join(tree, 'src'), { recursive: true });
  mkdirSync(join(tree, 'test'), { recursive: true });
  mkdirSync(folder, { recursive: true });
});
afterEach(() => dir.remove());

describe('readNodeCoverage, records of real node processes', () => {
  const FOLD = [
    'export const early = (x) => {', // 1
    '  if (x > 10) {', // 2
    '    return x * 2;', // 3
    '  }', // 4
    '  return x + 1;', // 5
    '};', // 6
    'export const late = () => {', // 7
    '  return 2;', // 8
    '};', // 9
    '',
  ].join('\n');

  /** Runs `test` of the tree as its own node process, writing its coverage in the folder. */
  const run = (test: string): void => {
    const { NODE_TEST_CONTEXT: _context, NODE_V8_COVERAGE: _own, ...env } = process.env;
    execFileSync(process.execPath, [test], {
      cwd: tree,
      env: { ...env, NODE_V8_COVERAGE: folder },
      stdio: 'pipe',
    });
  };

  it('reaches the lines each test file ran, from the first script of its process', () => {
    writeFileSync(join(tree, 'src', 'fold.mjs'), FOLD);
    writeFileSync(
      join(tree, 'test', 'a.test.mjs'),
      "import { early } from '../src/fold.mjs';\nearly(1);\n",
    );
    writeFileSync(
      join(tree, 'test', 'b.test.mjs'),
      "import { early, late } from '../src/fold.mjs';\nearly(1);\nlate();\n",
    );
    run('test/b.test.mjs');
    run('test/a.test.mjs');
    const coverage = readNodeCoverage(folder, tree, ['test/a.test.mjs', 'test/b.test.mjs']);
    assert.ok(typeof coverage === 'object', String(coverage));
    assert.deepStrictEqual([...coverage.keys()].sort(), ['test/a.test.mjs', 'test/b.test.mjs']);
    const file = 'src/fold.mjs';
    const reach = reachOf({
      coverage,
      sources: new Map([[file, readFileSync(join(tree, file), 'utf8')]]),
      lines: [3, 5, 8].map((line) => ({ file, line })),
    });
    assert.deepStrictEqual(reach, {
      kind: 'reached',
      lines: [
        { file, line: 3, tests: [] },
        { file, line: 5, tests: ['test/a.test.mjs', 'test/b.test.mjs'] },
        { file, line: 8, tests: ['test/b.test.mjs'] },
      ],
    });
  });

  it('names each test file of a `node --test` run with a preload, which the runner loads too', () => {
    // The test line of a repository may preload a script of the tree (`--import`), which every
    // process compiles before its test file.
    writeFileSync(join(tree, 'src', 'preload.mjs'), 'export const loaded = true;\n');
    writeFileSync(join(tree, 'src', 'fold.mjs'), FOLD);
    writeFileSync(
      join(tree, 'test', 'a.test.mjs'),
      "import { early } from '../src/fold.mjs';\nearly(1);\n",
    );
    writeFileSync(
      join(tree, 'test', 'b.test.mjs'),
      "import { late } from '../src/fold.mjs';\nlate();\n",
    );
    const { NODE_TEST_CONTEXT: _context, NODE_V8_COVERAGE: _own, ...env } = process.env;
    execFileSync(
      process.execPath,
      ['--import', './src/preload.mjs', '--test', 'test/a.test.mjs', 'test/b.test.mjs'],
      { cwd: tree, env: { ...env, NODE_V8_COVERAGE: folder }, stdio: 'pipe' },
    );
    const coverage = readNodeCoverage(folder, tree, ['test/a.test.mjs', 'test/b.test.mjs']);
    assert.ok(typeof coverage === 'object', String(coverage));
    assert.deepStrictEqual([...coverage.keys()].sort(), ['test/a.test.mjs', 'test/b.test.mjs']);
    assert.ok(coverage.get('test/a.test.mjs')?.has('src/preload.mjs'));
  });
});
