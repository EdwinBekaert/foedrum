// scripts/test-outcomes-reporter.ts under the real node:test runner (ADR 0021): the unit tests
// feed it events written by hand, so this test checks that the runner still emits what they
// assume: the file on every event, suites marked as suites, nesting per file, and a file that
// fails to load as a failed test named after the file.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const reporter = join(import.meta.dirname, '..', '..', 'scripts', 'test-outcomes-reporter.ts');

describe('test-outcomes-reporter under node --test', () => {
  let dir: TempDir;
  before(() => {
    dir = makeTempDir('outcomes-reporter');
    writeFileSync(
      join(dir.path, 'a.test.ts'),
      [
        "import assert from 'node:assert/strict';",
        "import { describe, it } from 'node:test';",
        "describe('suite', () => {",
        "  describe('inner', () => {",
        "    it('passes', () => {});",
        "    it('fails', () => assert.fail('planted'));",
        '  });',
        "  it.skip('skipped', () => {});",
        "  it.todo('todo');",
        '});',
        "it('top level', () => {});",
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir.path, 'b.test.ts'), "throw new Error('fails to load');\n");
  });
  after(() => dir.remove());

  // The outcome lines the reporter writes for a run of the given files, sorted.
  const outcomesOf = (...files: string[]): unknown[] => {
    const out = join(dir.path, 'outcomes.jsonl');
    const run = spawnSync(
      process.execPath,
      [
        '--test',
        `--test-reporter=${pathToFileURL(reporter).href}`,
        `--test-reporter-destination=${out}`,
        ...files,
      ],
      // Without NODE_TEST_CONTEXT, which would make the child skip its files as a nested run.
      {
        cwd: dir.path,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
    assert.equal(run.error, undefined);
    return readFileSync(out, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  };

  it('writes a suite whose after hook throws as a failure, though its tests pass', () => {
    writeFileSync(
      join(dir.path, 'c.test.ts'),
      [
        "import { after, describe, it } from 'node:test';",
        "describe('cleanup', () => {",
        "  after(() => { throw new Error('cleanup failed'); });",
        "  it('passes', () => {});",
        '});',
        '',
      ].join('\n'),
    );
    assert.deepEqual(outcomesOf('c.test.ts'), [
      { file: 'c.test.ts', test: ['cleanup', 'passes'], ok: true },
      { file: 'c.test.ts', test: ['cleanup'], ok: false },
    ]);
  });

  it('writes one line per test that ran, with its file, suites and outcome', () => {
    assert.deepEqual(outcomesOf('a.test.ts', 'b.test.ts'), [
      { file: 'a.test.ts', test: ['suite', 'inner', 'fails'], ok: false },
      { file: 'a.test.ts', test: ['suite', 'inner', 'passes'], ok: true },
      { file: 'a.test.ts', test: ['top level'], ok: true },
      { file: 'b.test.ts', test: ['b.test.ts'], ok: false },
    ]);
  });
});
