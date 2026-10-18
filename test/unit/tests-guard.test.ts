// The testsUnchanged guard around the brewer runner (ADR 0017, ADR 0078): once an attempt of a
// guarded step succeeded, it reads from git what the proven step committed and what the attempt
// changed, and fails the attempt when it changed or removed a test declaration or assertion. Runs
// with the fake brewer runner and a fake git (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { guardTests } from '../../src/checks/tests-guard.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';

const root = join('/work', 'acme.api', 'attempts', '12-1');
const clone = join('/work', 'acme.api', 'clone.git');
const deadlineAt = '2026-10-18T12:30:00.000Z';
const gaugeStart = 'a'.repeat(40);
const implementStart = 'c'.repeat(40);
const ref: AttemptRef = { batchId: '12-1', stepId: 'implement', attempt: 1 };

const worktree = (stepId: string, commit: string) => ({
  repo: 'acme/api',
  path: join(root, stepId, '1'),
  branch: `foedrum/12-1/${stepId}/1`,
  commit,
});
const ordered: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'l', source: 'label' },
];
const gauged: Event[] = [
  { type: 'step.scheduled', batchId: '12-1', stepId: 'gauge', attempt: 1, deadlineAt },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId: 'gauge',
    attempt: 1,
    worktree: worktree('gauge', gaugeStart),
  },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'gauge',
    attempt: 1,
    outcome: { kind: 'succeeded', output: null },
  },
];
const implementing: Event[] = [
  { type: 'step.scheduled', ...ref, deadlineAt },
  { type: 'step.started', ...ref, worktree: worktree('implement', implementStart) },
];

const diff = (path: string, removed: string[], added: string[]) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');

const gaugeDiff = [
  'diff --git a/test/add.test.mjs b/test/add.test.mjs',
  '--- /dev/null',
  '+++ b/test/add.test.mjs',
  '@@ -0,0 +1,3 @@',
  "+test('adds two numbers', () => {",
  '+  assert.equal(add(1, 2), 3);',
  '+});',
  '',
].join('\n');

/** What the fake brewer committed: an assertion made weaker. */
const weakened = diff(
  'test/add.test.mjs',
  ['  assert.equal(add(1, 2), 3);'],
  ['  assert.ok(add(1, 2));'],
);
/** A fixture and the implementation. */
const fixture = [
  'diff --git a/test/fixtures/pairs.json b/test/fixtures/pairs.json',
  '--- /dev/null',
  '+++ b/test/fixtures/pairs.json',
  '@@ -0,0 +1 @@',
  '+[[1, 2]]',
  diff(
    'src/add.mjs',
    ["export const add = () => { throw new Error('not implemented'); };"],
    ['export const add = (a, b) => a + b;'],
  ),
].join('\n');

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });

const setup = ({
  events = [...ordered, ...gauged, ...implementing],
  behaviour = behave.succeed(),
  changes = ok(weakened),
  protects = 'gauge' as string | null,
  git: gitOverride,
}: {
  events?: Event[];
  behaviour?: Behaviour;
  changes?: GitResult;
  /** `null`: the step has no testsUnchanged guard. */
  protects?: string | null;
  git?: Git;
} = {}) => {
  const calls: { cwd: string; args: readonly string[]; options?: GitOptions }[] = [];
  const git: Git =
    gitOverride ??
    ((cwd, args, options) => {
      calls.push({ cwd, args, ...(options === undefined ? {} : { options }) });
      return Promise.resolve(args.includes(gaugeStart) ? ok(gaugeDiff) : changes);
    });
  const asked: AttemptRef[] = [];
  const runner = guardTests({
    runner: fakeBrewerRunner({ implement: [behaviour] }),
    state: () => fold(events),
    protects: (attempt) => {
      asked.push(attempt);
      return protects ?? undefined;
    },
    git,
    clone: (repo) => (repo === 'acme/api' ? clone : join('/work', 'other')),
  });
  return { calls, asked, runner };
};

describe('guardTests (ADR 0078)', () => {
  it('stops a brewer that weakens an assertion of the red tests (done when, #176)', async () => {
    const { calls, runner } = setup();
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason:
        'the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, test/add.test.mjs: assert.equal(add(1, 2), 3);',
    });
    const flags =
      '-c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --text --no-renames --unified=0 --src-prefix=a/ --dst-prefix=b/';
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, args.join(' ')]),
      [
        // In the clone, never the attempt's worktree, whose .git file its brewer can rewrite.
        [clone, `${flags} ${gaugeStart} refs/heads/foedrum/12-1/gauge/1 --`],
        // Its own commits end at its branch, which the task tree carries on, whatever HEAD is,
        // and only in the files the proven step committed, each read as a literal path.
        [
          clone,
          `${flags} ${implementStart} refs/heads/foedrum/12-1/implement/1 -- :(literal)test/add.test.mjs`,
        ],
      ],
    );
    // A large but ordinary change still reads: past the runner's default 4 MiB.
    assert.deepEqual(
      calls.map(({ options }) => options?.maxOutputBytes),
      [16 * 1024 * 1024, 16 * 1024 * 1024],
    );
  });

  it('lets through a brewer that only adds a fixture (done when, #176)', async () => {
    const { runner } = setup({ changes: ok(fixture) });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
  });

  it('names how many more lines changed after the first', async () => {
    const both = diff(
      'test/add.test.mjs',
      ["test('adds two numbers', () => {", '  assert.equal(add(1, 2), 3);'],
      [],
    );
    const { runner } = setup({ changes: ok(both) });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(
      end.ending.kind === 'failed' && end.ending.reason,
      "the guard testsUnchanged: the attempt changed or removed 2 lines of the tests of step gauge, test/add.test.mjs: test('adds two numbers', () => { (and 1 more)",
    );
  });

  it('reads nothing for a step without the guard, or an attempt that did not succeed', async () => {
    const unguarded = setup({ protects: null });
    const end = await unguarded.runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(unguarded.asked, [ref]);
    assert.deepEqual(unguarded.calls, []);

    const blocked = setup({ behaviour: behave.blocked('findings', 'The test is wrong') });
    const ended = await blocked.runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(ended.ending.kind, 'blocked');
    assert.deepEqual(blocked.calls, []);
  });

  it('has nothing to guard when the proven step never succeeded, as when the batch skipped it', async () => {
    const { calls, runner } = setup({ events: [...ordered, ...implementing] });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(calls, []);
  });

  it('is blocked on the environment when git cannot read the commits', async () => {
    const { runner } = setup({
      changes: { code: 128, stdout: '', stderr: 'fatal: bad object HEAD\n' },
    });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard testsUnchanged cannot read the commits of step implement: fatal: bad object HEAD',
    });
  });

  it('reports progress while it reads, so the lease holds, and stopping it cancels the attempt', async () => {
    let release: (result: GitResult) => void = () => {};
    let signal: AbortSignal | undefined;
    const git: Git = (_cwd, _args, options) => {
      signal = options?.signal;
      return new Promise((resolve) => {
        release = resolve;
        options?.signal?.addEventListener('abort', () =>
          resolve({ code: null, stdout: '', stderr: '' }),
        );
      });
    };
    const { runner } = setup({ git });
    const running = runner.start({ ref, limits: defaultLimits });
    // The fake brewer settles on the next turn, then the guard calls git.
    while (signal === undefined) await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(runner.progress(ref), undefined);
    running.stop();
    const end = await running.ended;
    assert.equal(signal.aborted, true);
    assert.deepEqual(end.ending, { kind: 'cancelled' });
    assert.equal(runner.progress(ref), undefined);
    release(ok(''));
  });
});
