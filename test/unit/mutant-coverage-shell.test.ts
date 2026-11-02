import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Range } from '../../scripts/mutant-coverage/core.ts';
import { main } from '../../scripts/mutant-coverage.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// a.ts: `used` runs for every caller, `unused` for none.
const A = [
  'export const used = (): number => {', // 1
  '  return 1;', // 2
  '};', // 3
  'export const unused = (): number => {', // 4
  '  return 2;', // 5
  '};', // 6
].join('\n');

describe('the covering test files of mutated lines, from V8 coverage files', () => {
  let dir: TempDir;
  let tree: string;
  let coverage: string;

  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    writeFileSync(join(tree, file), text);
  };

  const range = (from: string, to: string, count: number): Range => {
    const startOffset = A.indexOf(from);
    assert.ok(startOffset >= 0, `${from} in a.ts`);
    return { startOffset, endOffset: A.indexOf(to, startOffset) + to.length, count };
  };

  // A coverage file as a test file's child writes it: the test file, the preload and a.ts.
  const record = (name: string, test: string): void => {
    const script = (path: string, ranges: Range[]) => ({
      scriptId: String(Math.random()),
      url: pathToFileURL(join(tree, path)).href,
      functions: [{ functionName: '', ranges, isBlockCoverage: true }],
    });
    const result = [
      { scriptId: '0', url: 'node:internal/main/run_main_module', functions: [] },
      script(test, [{ startOffset: 0, endOffset: 10, count: 1 }]),
      script('src/a.ts', [
        { startOffset: 0, endOffset: A.length, count: 1 },
        range('(): number => {\n  return 1', '};', 1),
        range('(): number => {\n  return 2', '};', 0),
      ]),
    ];
    writeFileSync(join(coverage, name), JSON.stringify({ result }));
  };

  beforeEach(() => {
    dir = makeTempDir('mutant-coverage');
    tree = join(dir.path, 'tree');
    coverage = join(dir.path, 'coverage');
    mkdirSync(coverage);
    write('src/a.ts', A);
    write('test/unit/b.test.ts', "import '../../src/a.ts';\n");
    write('test/unit/c.test.ts', "import '../../src/a.ts';\n");
  });
  afterEach(() => dir.remove());

  it('a line no test file covers is reported as not run and runs nothing', async () => {
    record('coverage-1-1-0.json', 'test/unit/c.test.ts');
    record('coverage-2-1-0.json', 'test/unit/b.test.ts');
    assert.deepEqual(await main([tree, coverage, 'src/a.ts:5', 'src/a.ts:2']), {
      exitCode: 0,
      stdout: [
        'not covered src/a.ts:5',
        'covered src/a.ts:2: test/unit/b.test.ts test/unit/c.test.ts',
      ],
      stderr: [],
    });
  });

  it('an empty coverage folder falls back to the direct and wide rounds', async () => {
    assert.deepEqual(await main([tree, coverage, 'src/a.ts:2']), {
      exitCode: 0,
      stdout: ['fallback: no coverage record names a test file of the run'],
      stderr: [],
    });
  });

  it('a coverage file it cannot read falls back to the direct and wide rounds', async () => {
    record('coverage-1-1-0.json', 'test/unit/c.test.ts');
    writeFileSync(join(coverage, 'coverage-2-1-0.json'), '{"result": [');
    assert.deepEqual(await main([tree, coverage, 'src/a.ts:2']), {
      exitCode: 0,
      stdout: ['fallback: cannot read coverage-2-1-0.json: not V8 coverage'],
      stderr: [],
    });
  });

  it('a test file two coverage records name is run as covering every line', async () => {
    record('coverage-1-1-0.json', 'test/unit/c.test.ts');
    record('coverage-2-1-0.json', 'test/unit/c.test.ts');
    record('coverage-3-1-0.json', 'test/unit/b.test.ts');
    assert.deepEqual((await main([tree, coverage, 'src/a.ts:5'])).stdout, [
      'covered src/a.ts:5: test/unit/c.test.ts',
    ]);
  });

  it('says how to use it, and refuses a location that is not a file of the tree and a line', async () => {
    for (const argv of [[], [tree], [tree, coverage]]) {
      const result = await main(argv);
      assert.equal(result.exitCode, 2, argv.join(' '));
      assert.match(result.stderr.join('\n'), /^usage: /);
    }
    for (const location of [
      'src/a.ts',
      'src/a.ts:0',
      'src/a.ts:7',
      'src/a.ts:x',
      'src/missing.ts:2',
    ]) {
      assert.deepEqual(await main([tree, coverage, location]), {
        exitCode: 1,
        stdout: [],
        stderr: [`mutant-coverage: ${location} is not a line of a source file of the tree`],
      });
    }
  });
});
