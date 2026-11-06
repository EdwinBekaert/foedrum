// The tests a Gauger named against the run's reports in the check runner (ADR 0342): a red proof and
// a check step's test check record the names the reports hold under no name, and fail for none of
// them. An injected process runner, git and reports (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCheckRunner, type ReportFiles } from '../../src/checks/check-runner.ts';
import type { MapRead } from '../../src/checks/test-map.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { TestMap, TestMapModule } from '../../src/schemas/test-map.ts';
import type { Git } from '../../src/workspace/git.ts';

const deadlineAt = '2026-11-06T12:30:00.000Z';
const base = 'a'.repeat(40);
const tip = 'b'.repeat(40);
const tree = join('/work', 'acme.api', 'attempts', 'check');

const api: TestMapModule = {
  name: 'api',
  code: ['src/**'],
  tests: { paths: ['test/**'] },
  testReport: { format: 'tap', path: 'api.tap' },
  coverage: 'none',
};
const mapOf = (...modules: TestMapModule[]): TestMap => ({
  derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
  modules,
});

// The Gauger's commit: a test under test/unit and one under test/integration.
const diff = [
  'diff --git a/test/unit/add.test.mjs b/test/unit/add.test.mjs',
  '--- /dev/null',
  '+++ b/test/unit/add.test.mjs',
  '@@ -0,0 +1 @@',
  "+test('adds two numbers', () => {});",
  'diff --git a/test/integration/add.test.mjs b/test/integration/add.test.mjs',
  '--- /dev/null',
  '+++ b/test/integration/add.test.mjs',
  '@@ -0,0 +1 @@',
  "+test('adds through the real tool', () => {});",
  '',
].join('\n');

const tap = (...points: string[]): string =>
  ['TAP version 13', ...points, `1..${points.length}`, ''].join('\n');
const fails = (name: string): string =>
  `not ok 1 - ${name}\n  ---\n  error: 'not implemented'\n  ...`;

const UNIT = 'adds two numbers';
const INTEGRATION = 'adds through the real tool';

const run = async ({
  stepId = 'red',
  named = { tests: [UNIT, INTEGRATION] } as Record<string, unknown>,
  report = tap(fails(UNIT)) as string | null,
  exitCode = stepId === 'red' ? 1 : 0,
  map = mapOf(api),
  at = {} as Record<string, MapRead>,
  redProof = true,
  surveys = false,
  unread = false,
}: {
  stepId?: string;
  /** The Gauger's out doc's lists. */
  named?: Record<string, unknown>;
  /** The test report the run wrote; null: none. */
  report?: string | null;
  exitCode?: number;
  map?: TestMap;
  /** The maps by commit, where they differ from `map`. */
  at?: Record<string, MapRead>;
  /** Whether the recipe has a red proof. */
  redProof?: boolean;
  /** Whether the step is a survey's check. */
  surveys?: boolean;
  /** Whether the report cannot be read. */
  unread?: boolean;
} = {}) => {
  const ref = { batchId: '1-1', stepId, attempt: 1 };
  const events: Event[] = [
    { type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy: deadlineAt },
    { type: 'batch.recipe_chosen', batchId: '1-1', recipe: 'nip', reason: 'l', source: 'label' },
    { type: 'step.scheduled', batchId: '1-1', stepId: 'gauge', attempt: 1, deadlineAt },
    {
      type: 'step.started',
      batchId: '1-1',
      stepId: 'gauge',
      attempt: 1,
      worktree: { repo: 'acme/api', path: join('/work', 'gauge'), branch: 'gauge', commit: base },
    },
    {
      type: 'step.finished',
      batchId: '1-1',
      stepId: 'gauge',
      attempt: 1,
      outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Gauged', ...named } },
    },
    { type: 'step.scheduled', ...ref, deadlineAt },
    {
      type: 'step.started',
      ...ref,
      worktree: { repo: 'acme/api', path: tree, branch: 'check', commit: tip },
    },
  ];
  const exec: ExecProcess = async () => ({ exitCode, stdout: '', stderr: '', output: '' });
  const git: Git = async () => ({ code: 0, stdout: diff, stderr: '' });
  const reports: ReportFiles = {
    clear: () => {},
    read: () =>
      unread ? { kind: 'unread', reason: 'too big' } : { kind: 'text', text: report ?? '' },
  };
  const checks: StepChecks = {
    find: () => ['test'],
    any: () => true,
    proves: (_recipe, step) => (redProof && step === 'red' ? 'gauge' : undefined),
    redProof: () => (redProof ? { id: 'red', of: 'gauge' } : undefined),
    ...(surveys ? { surveys: () => ({ of: 'survey', maxRounds: 1 }) } : {}),
  };
  const runner = createCheckRunner({
    state: () => fold(events),
    checks,
    repositoryChecks: () => ({
      build: null,
      typecheck: null,
      lint: null,
      format: null,
      test: 'npm test',
    }),
    testReport: () => undefined,
    exec,
    git,
    clone: () => join('/work', 'acme.api', 'clone.git'),
    reports,
    env: { base: {}, forced: {} },
    clock: () => new Date('2026-11-06T12:00:00.000Z'),
    platform: 'linux',
    testMap: {
      at: async (_repo: string, commit: string) => at[commit] ?? { kind: 'map', map },
      reports: (pattern: string) => ({
        paths: report === null && !unread ? [] : [join(tree, pattern)],
      }),
      realPath: (path: string) => path,
      isFolder: () => false,
      manifests: async () => ({ kind: 'fresh' }),
      touched: async () => ({ paths: [] }),
    },
  });
  return runner.start({
    ref,
    limits: { outDoc: { file: 'out.md', schema: undefined as never } },
  }).ended;
};

describe('createCheckRunner: the tests a Gauger named (ADR 0342)', () => {
  describe('at a red proof', () => {
    it('records a named test the reports do not hold, and the proof passes', async () => {
      const end = await run();
      assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
      assert.deepEqual(end.unreported, { tests: [INTEGRATION], more: 0 });
    });

    it('records no name when the reports hold every one, saying they were read', async () => {
      const end = await run({ named: { tests: [UNIT] } });
      assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
      assert.deepEqual(end.unreported, { tests: [], more: 0 });
    });

    it('records a named regression test the reports do not hold', async () => {
      const end = await run({ named: { tests: [UNIT], regressionTests: ['keeps the sign'] } });
      assert.deepEqual(end.unreported, { tests: ['keeps the sign'], more: 0 });
    });

    it('a template name reads as unreported, and nothing fails', async () => {
      const end = await run({
        named: { tests: [UNIT, 'rejects %s'] },
        report: tap(fails(UNIT), 'ok 2 - rejects 1'),
      });
      assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
      assert.deepEqual(end.unreported, { tests: ['rejects %s'], more: 0 });
    });

    it('a run with no failing test says how many named tests it does not hold, naming none', async () => {
      const end = await run({ report: tap('ok 1 - subtracts'), exitCode: 0 });
      assert.deepEqual(end.ending, {
        kind: 'failed',
        retryable: false,
        reason:
          'the red proof of step gauge failed: no test fails, so none shows the behaviour missing: the run reports no test named as 2 of the 2 tests step gauge named, so "npm test" may not run them',
      });
    });

    it('a failing test outside the changed files says how many named tests it does not hold', async () => {
      const end = await run({
        report: tap(
          "not ok 1 - subtracts\n  ---\n  location: 'test/unit/old.test.mjs:1:1'\n  error: 'x'\n  ...",
        ),
      });
      assert.equal(end.ending.kind, 'failed');
      assert.match(
        end.ending.kind === 'failed' ? end.ending.reason : '',
        /fails in test\/unit\/old\.test\.mjs: the run reports no test named as 2 of the 2 tests step gauge named, so "npm test" may not run them$/,
      );
    });
  });

  describe('at a check step', () => {
    it('records a named test the reports of a passing run do not hold', async () => {
      const end = await run({ stepId: 'green', report: tap(`ok 1 - ${UNIT}`) });
      assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
      assert.deepEqual(end.unreported, { tests: [INTEGRATION], more: 0 });
    });

    it('records no name when the reports of a passing run hold every one, saying they were read', async () => {
      const end = await run({
        stepId: 'green',
        report: tap(`ok 1 - ${UNIT}`, `ok 2 - ${INTEGRATION}`),
      });
      assert.deepEqual(end.unreported, { tests: [], more: 0 });
    });
  });
});
