// The V8 coverage a baseline run's processes wrote (#1176, ADR 0431, ADR 0303), read per test file
// from a folder on disk: records written by hand, and by real node processes, whose first script of
// the tree must be the file they were started on.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { reachOf } from '../../src/checks/mutant-reach.ts';
import { readNodeCoverage } from '../../src/checks/node-coverage.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
let tree: string;
let folder: string;

beforeEach(() => {
  dir = makeTempDir('node-coverage');
  tree = join(dir.path, 'tree');
  folder = join(dir.path, 'v8');
  mkdirSync(join(tree, 'src'), { recursive: true });
  mkdirSync(join(tree, 'test'), { recursive: true });
  mkdirSync(folder);
});
afterEach(() => dir.remove());

const range = (startOffset: number, endOffset: number, count: number) => ({
  startOffset,
  endOffset,
  count,
});

/** A coverage file of scripts, `[url, ranges]`, as V8 writes it. */
const record = (...scripts: [url: string, ranges: ReturnType<typeof range>[]][]): string =>
  JSON.stringify({
    result: scripts.map(([url, ranges]) => ({
      scriptId: '1',
      url,
      functions: [{ functionName: '', ranges, isBlockCoverage: true }],
    })),
  });

const urlOf = (...parts: string[]): string => pathToFileURL(join(tree, ...parts)).href;

describe('readNodeCoverage, the records of a folder', () => {
  it('takes the first script of the tree of each record as its test file, with every script of the tree', () => {
    writeFileSync(
      join(folder, 'coverage-2.json'),
      record(
        ['node:internal/main', [range(0, 5, 1)]],
        [urlOf('test', 'b.test.ts'), [range(0, 9, 1)]],
        [urlOf('src', 'fold.ts'), [range(0, 20, 1), range(3, 8, 0)]],
        [urlOf('src', 'late.ts'), [range(0, 4, 1)]],
      ),
    );
    writeFileSync(
      join(folder, 'coverage-1.json'),
      record([urlOf('test', 'a.test.ts'), [range(0, 7, 1)]]),
    );
    const coverage = readNodeCoverage(folder, tree);
    assert.deepStrictEqual(
      coverage,
      new Map([
        ['test/a.test.ts', new Map([['test/a.test.ts', [range(0, 7, 1)]]])],
        [
          'test/b.test.ts',
          new Map([
            ['test/b.test.ts', [range(0, 9, 1)]],
            ['src/fold.ts', [range(0, 20, 1), range(3, 8, 0)]],
            ['src/late.ts', [range(0, 4, 1)]],
          ]),
        ],
      ]),
    );
  });

  it('leaves out a record that loaded nothing of the tree, and a file that is no record', () => {
    // A process outside the tree, a folder beside it whose name starts with the tree's, and node's own.
    writeFileSync(
      join(folder, 'coverage-1.json'),
      record(
        ['node:internal/main', [range(0, 5, 1)]],
        [pathToFileURL(`${tree}-beside/test/a.test.ts`).href, [range(0, 7, 1)]],
      ),
    );
    writeFileSync(join(folder, 'coverage-2.json'), JSON.stringify({ result: [] }));
    writeFileSync(join(folder, 'notes.txt'), 'not json at all');
    assert.deepStrictEqual(readNodeCoverage(folder, tree), new Map());
  });

  it('reads a tree named by a link by the real path the loader names', () => {
    const link = join(dir.path, 'link');
    symlinkSync(tree, link, 'junction');
    writeFileSync(
      join(folder, 'coverage-1.json'),
      record([urlOf('test', 'a.test.ts'), [range(0, 7, 1)]]),
    );
    assert.deepStrictEqual(
      readNodeCoverage(folder, link),
      new Map([['test/a.test.ts', new Map([['test/a.test.ts', [range(0, 7, 1)]]])]]),
    );
  });

  it('holds no coverage for a folder no process made', () => {
    assert.deepStrictEqual(readNodeCoverage(join(dir.path, 'never-made'), tree), new Map());
  });

  it('says why a folder that is none cannot be read, as only a missing one is empty', () => {
    const file = join(dir.path, 'a-file');
    writeFileSync(file, '');
    const read = readNodeCoverage(file, tree);
    assert.equal(typeof read, 'string');
    assert.match(String(read), /^cannot read the folder: /);
  });

  it('says why a record is not V8 coverage, naming it quoted, wrong in its shape or in its JSON', () => {
    for (const text of [
      'not JSON',
      '{"result": "no"}',
      JSON.stringify({ result: [{ url: 1, functions: [] }] }),
      JSON.stringify({
        result: [{ url: 'file:///x', functions: [{ ranges: [{ startOffset: 'a' }] }] }],
      }),
    ]) {
      writeFileSync(join(folder, 'coverage-1.json'), text);
      assert.equal(
        readNodeCoverage(folder, tree),
        'cannot read "coverage-1.json": not V8 coverage',
      );
    }
  });

  it('says why a script URL is no path of this machine', () => {
    const odd = process.platform === 'win32' ? 'file:///no-drive/x.ts' : 'file://host/x.ts';
    writeFileSync(join(folder, 'coverage-1.json'), record([odd, [range(0, 1, 1)]]));
    assert.equal(readNodeCoverage(folder, tree), 'cannot read "coverage-1.json": not V8 coverage');
  });

  it('says why a record cannot be read, by the error code and not the path', () => {
    mkdirSync(join(folder, 'coverage-1.json'));
    assert.equal(readNodeCoverage(folder, tree), 'cannot read "coverage-1.json": EISDIR');
  });

  it('refuses two records that name one test file, which one of them would stand for', () => {
    for (const name of ['coverage-1.json', 'coverage-2.json']) {
      writeFileSync(join(folder, name), record([urlOf('test', 'a.test.ts'), [range(0, 7, 1)]]));
    }
    assert.equal(
      readNodeCoverage(folder, tree),
      'two coverage records name the test file "test/a.test.ts"',
    );
  });
});

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
    const coverage = readNodeCoverage(folder, tree);
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
});
