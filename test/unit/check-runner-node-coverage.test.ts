// The check runner's own reading of the coverage a baseline run wrote (#1176, ADR 0431): with no
// reader injected, through the file system, and told which files the run's test reports place tests
// in. The runs with an injected reader are in test/unit/check-runner-test-map.test.ts.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import { fold } from '../../src/engine/fold.ts';
import type { TestMapModule } from '../../src/schemas/test-map.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
beforeEach(() => {
  dir = makeTempDir('check-runner-node-coverage');
});
afterEach(() => dir.remove());

const api: TestMapModule = {
  name: 'api',
  code: ['src/**'],
  tests: { paths: ['test/**'] },
  testReport: { format: 'junit', path: 'report.xml' },
  coverage: 'none',
};

describe("createCheckRunner's testRun, the coverage a baseline records (ADR 0431)", () => {
  it('reads the records the test check wrote through the file system, by the files its reports name', async () => {
    const tree = join(dir.path, 'tree');
    mkdirSync(join(tree, 'src'), { recursive: true });
    const report = join(tree, 'report.xml');
    const urlOf = (...parts: string[]) => pathToFileURL(join(tree, ...parts)).href;
    const scriptOf = (url: string, endOffset: number) => ({
      url,
      functions: [{ ranges: [{ startOffset: 0, endOffset, count: 1 }] }],
    });
    const runner = createCheckRunner({
      state: () => fold([]),
      checks: {
        find: () => undefined,
        any: () => true,
        proves: () => undefined,
        redProof: () => undefined,
      },
      repositoryChecks: () => ({
        build: null,
        typecheck: null,
        lint: null,
        format: null,
        test: 'npm test',
        testFiles: 'npm test -- {files}',
      }),
      testReport: () => undefined,
      // The test check's process writes two records: a test file's, after a preload, and the runner's.
      exec: (_line, _args, options) => {
        const folder = options.env?.NODE_V8_COVERAGE;
        assert.ok(typeof folder === 'string', String(folder));
        mkdirSync(folder, { recursive: true });
        writeFileSync(
          join(folder, 'coverage-1.json'),
          JSON.stringify({
            result: [
              scriptOf(urlOf('src', 'preload.ts'), 3),
              scriptOf(urlOf('test', 'a.test.ts'), 7),
            ],
          }),
        );
        writeFileSync(
          join(folder, 'coverage-2.json'),
          JSON.stringify({ result: [scriptOf(urlOf('src', 'preload.ts'), 3)] }),
        );
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', output: '' });
      },
      git: async () => ({ code: 0, stdout: '', stderr: '' }),
      reports: {
        clear: () => {},
        read: (file) =>
          file === report
            ? {
                kind: 'text',
                text: '<testsuites><testsuite name="all"><testcase name="adds" file="test/a.test.ts" line="3"/></testsuite></testsuites>',
              }
            : { kind: 'missing' },
      },
      clone: () => join(dir.path, 'clone.git'),
      env: { base: {}, forced: {} },
      clock: () => new Date('2026-11-27T12:00:00.000Z'),
      platform: 'linux',
      testMap: {
        at: async () => ({ kind: 'none' }),
        reports: () => ({ paths: [report] }),
      },
    });
    const end = await runner.testRun(
      { repo: 'acme/api', path: tree },
      [{ module: api, added: false }],
      '2026-11-27T12:30:00.000Z',
      new AbortController().signal,
      { coverage: true },
    );
    const ran = end.kind === 'ran' ? end : assert.fail(end.kind === 'unrun' ? end.why : '');
    assert.deepStrictEqual(
      ran.coverage,
      new Map([
        [
          'test/a.test.ts',
          new Map([
            ['src/preload.ts', [{ startOffset: 0, endOffset: 3, count: 1 }]],
            ['test/a.test.ts', [{ startOffset: 0, endOffset: 7, count: 1 }]],
          ]),
        ],
      ]),
    );
  });
});
