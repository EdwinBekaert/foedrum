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

  it('writes one line per test that ran, with its file, suites and outcome', () => {
    const out = join(dir.path, 'outcomes.jsonl');
    const run = spawnSync(
      process.execPath,
      [
        '--test',
        `--test-reporter=${pathToFileURL(reporter).href}`,
        `--test-reporter-destination=${out}`,
        'a.test.ts',
        'b.test.ts',
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
    const outcomes = readFileSync(out, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      outcomes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [
        { file: 'a.test.ts', test: ['suite', 'inner', 'fails'], ok: false },
        { file: 'a.test.ts', test: ['suite', 'inner', 'passes'], ok: true },
        { file: 'a.test.ts', test: ['top level'], ok: true },
        { file: 'b.test.ts', test: ['b.test.ts'], ok: false },
      ],
    );
  });
});
