// The testsUnchanged guard around the brewer runner (ADR 0017, ADR 0078): once an attempt of a
// guarded step succeeded, it reads from git what the proven step committed and what the attempt
// changed, and fails the attempt when it changed or removed a test declaration or assertion. Runs
// with the fake brewer runner and a fake git (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { MapRead, ReadTestMapAt } from '../../src/checks/test-map.ts';
import { guardTests } from '../../src/checks/tests-guard.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
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

const gaugeTip = 'refs/heads/foedrum/12-1/gauge/1';
/** A test map whose one module keeps its tests under `tests`. */
const mapOf = (tests: string): MapRead => ({
  kind: 'map',
  map: {
    derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
    modules: [
      {
        name: 'api',
        code: ['src/**'],
        tests: { paths: [tests] },
        testReport: { format: 'tap', path: 'report.tap' },
        coverage: 'none',
      },
    ],
  },
});
const none: MapRead = { kind: 'none' };
/** What the fake brewer committed: a line of the red test that declares and asserts nothing. */
const closingDropped = diff('test/add.test.mjs', ['});'], []);
/** The red test file's lines as the Gauger committed them. */
const gaugeLines = ["test('adds two numbers', () => {", '  assert.equal(add(1, 2), 3);', '});'];
/** The red test file at the attempt's tip: as the Gauger left it, weakened, or without its `});`. */
const tips = {
  kept: { 'test/add.test.mjs': gaugeLines },
  weakened: {
    'test/add.test.mjs': gaugeLines.map((line) =>
      line.replace('assert.equal(add(1, 2), 3)', 'assert.ok(add(1, 2))'),
    ),
  },
  closing: { 'test/add.test.mjs': gaugeLines.slice(0, 2) },
} satisfies Record<string, Record<string, readonly string[]>>;
/** The object id the fake clone gives a file at the attempt's tip. */
const blobOf = (path: string) => `b${path.length.toString().padStart(39, '0')}`;

const setup = ({
  events = [...ordered, ...gauged, ...implementing],
  behaviour = behave.succeed(),
  changes = ok(weakened),
  protects = 'gauge' as string | null,
  git: gitOverride,
  maps,
  mapAt,
  tip = tips.weakened,
}: {
  events?: Event[];
  behaviour?: Behaviour;
  changes?: GitResult;
  /** `null`: the step has no testsUnchanged guard. */
  protects?: string | null;
  git?: Git;
  /** The test map by commit; absent, the guard reads none. */
  maps?: Readonly<Record<string, MapRead>>;
  /** The test map reader itself, in place of `maps`. */
  mapAt?: ReadTestMapAt;
  /** The files at the attempt's branch, by path: what `ls-tree` lists and `cat-file` reads. */
  tip?: Readonly<Record<string, readonly string[]>>;
} = {}) => {
  const mapReads: [string, string][] = [];
  const calls: { cwd: string; args: readonly string[]; options?: GitOptions }[] = [];
  const git: Git =
    gitOverride ??
    ((cwd, args, options) => {
      calls.push({ cwd, args, ...(options === undefined ? {} : { options }) });
      if (args.includes('ls-tree')) {
        const asked = args.slice(args.indexOf('--') + 1);
        const listed = asked.filter((path) => tip[path] !== undefined);
        return Promise.resolve(
          ok(listed.map((path) => `100644 blob ${blobOf(path)}\t${path}\0`).join('')),
        );
      }
      if (args.includes('cat-file')) {
        const path = Object.keys(tip).find((name) => args.includes(blobOf(name)));
        const lines = path === undefined ? undefined : tip[path];
        return Promise.resolve(
          lines === undefined
            ? { code: 128, stdout: '', stderr: 'fatal: Not a valid object name\n' }
            : ok(`${lines.join('\n')}\n`),
        );
      }
      return Promise.resolve(args.includes(gaugeStart) ? ok(gaugeDiff) : changes);
    });
  const asked: AttemptRef[] = [];
  const runner = guardTests({
    runner: fakeBrewerRunner(() => behaviour),
    state: () => fold(events),
    protects: (attempt) => {
      asked.push(attempt);
      return protects ?? undefined;
    },
    git,
    clone: (repo) => (repo === 'acme/api' ? clone : join('/work', 'other')),
    ...(mapAt !== undefined ? { testMap: mapAt } : {}),
    ...(maps === undefined
      ? {}
      : {
          testMap: (repo: string, commit: string) => {
            mapReads.push([repo, commit]);
            return Promise.resolve(maps[commit] ?? none);
          },
        }),
    platform: 'linux',
  });
  return { calls, asked, runner, mapReads };
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

  it('reads the worktree and branch a resumed attempt ran in, for its own and the proven step (#327, ADR 0117)', async () => {
    const claude = { version: '2.1.301', model: 'claude-sonnet-5-5' };
    const crashed = { kind: 'failed', retryable: true, reason: 'claude crashed' } as const;
    const session = (stepId: string) => ({
      id: `${stepId}-session`,
      worktree: join(root, stepId, '1'),
    });
    /** Attempt 1 of `stepId` crashed; attempt 2 resumed its session, with no worktree of its own. */
    const resumedOnce = (stepId: string, start: string): Event[] => {
      const at = (attempt: number) => ({ batchId: '12-1', stepId, attempt });
      return [
        { type: 'step.scheduled', ...at(1), deadlineAt },
        {
          type: 'step.started',
          ...at(1),
          session: session(stepId),
          worktree: worktree(stepId, start),
        },
        { type: 'step.finished', ...at(1), outcome: crashed, claude },
        { type: 'step.scheduled', ...at(2), deadlineAt, retry: true },
        {
          type: 'step.started',
          ...at(2),
          session: { ...session(stepId), resumes: `${stepId}-session` },
        },
      ];
    };
    const events: Event[] = [
      ...ordered,
      ...resumedOnce('gauge', gaugeStart),
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'gauge',
        attempt: 2,
        outcome: { kind: 'succeeded', output: null },
        claude,
      },
      ...resumedOnce('implement', implementStart),
    ];
    const { calls, runner } = setup({ events });
    const end = await runner.start({ ref: { ...ref, attempt: 2 }, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'failed');
    // Where each worktree started, to the branch of the attempt that made it (ADR 0117).
    assert.deepEqual(
      calls.map(({ args }) => args.slice(args.indexOf('--dst-prefix=b/') + 1).join(' ')),
      [
        `${gaugeStart} refs/heads/foedrum/12-1/gauge/1 --`,
        `${implementStart} refs/heads/foedrum/12-1/implement/1 -- :(literal)test/add.test.mjs`,
      ],
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

describe('guardTests: the test map (ADR 0274)', () => {
  const failedOn = (line: string) => ({
    kind: 'failed',
    retryable: true,
    reason: `the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, test/add.test.mjs: ${line}`,
  });

  it("keeps every line the red step added to a separate test file of the base's map", async () => {
    const maps = { [gaugeStart]: mapOf('test/**') };
    const { runner, mapReads } = setup({ changes: ok(closingDropped), maps, tip: tips.closing });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, failedOn('});'));
    // The base's map, where the batch started, and the map the proven step committed.
    assert.deepEqual(mapReads, [
      ['acme/api', gaugeStart],
      ['acme/api', gaugeTip],
    ]);
  });

  it("guards a test file only the proven step's map lists", async () => {
    const maps = { [gaugeTip]: mapOf('test/**') };
    const { runner } = setup({ changes: ok(closingDropped), maps, tip: tips.closing });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, failedOn('});'));
  });

  it('leaves a file in no test area of the map unguarded', async () => {
    const maps = { [gaugeStart]: mapOf('spec/**') };
    const { runner } = setup({ maps });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
  });

  it("reads each guarded test file at the attempt's branch in the clone, and a file it removed loses every line", async () => {
    const maps = { [gaugeStart]: mapOf('test/**') };
    const { runner, calls } = setup({ changes: ok(closingDropped), maps, tip: {} });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(
      end.ending.kind === 'failed' && end.ending.reason,
      "the guard testsUnchanged: the attempt changed or removed 3 lines of the tests of step gauge, test/add.test.mjs: test('adds two numbers', () => { (and 2 more)",
    );
    const listed = calls.find(({ args }) => args.includes('ls-tree'));
    assert.deepEqual(listed && [listed.cwd, listed.args.slice(-3)], [
      clone,
      ['refs/heads/foedrum/12-1/implement/1', '--', 'test/add.test.mjs'],
    ]);
    assert.equal(
      calls.some(({ args }) => args.includes('cat-file')),
      false,
    );
  });

  it('keeps a red line a later step removed a copy of, while the tip still holds it', async () => {
    const maps = { [gaugeStart]: mapOf('test/**') };
    const kept = setup({ changes: ok(closingDropped), maps, tip: tips.kept });
    const end = await kept.runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
    // The tip's text is read by the object `ls-tree` named, with the diff's bounds.
    const read = kept.calls.find(({ args }) => args.includes('cat-file'));
    assert.deepEqual(read?.args, ['cat-file', 'blob', blobOf('test/add.test.mjs')]);
    assert.equal(read?.options?.maxOutputBytes, 16 * 1024 * 1024);
  });

  it('a map only the proven step commits guards the files it places in no test area as no map does', async () => {
    const maps = { [gaugeTip]: mapOf('spec/**') };
    const { runner } = setup({ maps });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, failedOn('assert.equal(add(1, 2), 3);'));
  });

  it('is blocked on the environment when a test file cannot be read at the tip', async () => {
    const maps = { [gaugeStart]: mapOf('test/**') };
    const git: Git = (_cwd, args) =>
      Promise.resolve(
        args.includes('ls-tree')
          ? { code: 128, stdout: '', stderr: 'fatal: not a tree object\n' }
          : ok(args.includes(gaugeStart) ? gaugeDiff : closingDropped),
      );
    const { runner } = setup({ maps, git });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard testsUnchanged cannot read the commits of step implement: fatal: not a tree object',
    });
  });

  it('is blocked on the environment when a test map cannot be read', async () => {
    const unreadable: MapRead = { kind: 'unreadable', reason: 'it is not JSONC' };
    for (const commit of [gaugeStart, gaugeTip]) {
      const { runner } = setup({ maps: { [commit]: unreadable } });
      const end = await runner.start({ ref, limits: defaultLimits }).ended;
      assert.deepEqual(
        end.ending,
        {
          kind: 'blocked',
          blockerKind: 'environment',
          summary: `the guard testsUnchanged cannot read the test map of acme/api at ${commit}: it is not JSONC`,
        },
        commit,
      );
    }
  });
});

describe('guardTests: regression tests', () => {
  it("reads the base's map where the batch's latest merge of the base brought it in (ADR 0164)", async () => {
    const moved = 'd'.repeat(40);
    const merged: Event = {
      type: 'effect.applied',
      key: effectKey.encode(baseMergeKey(ref)),
      result: { base: moved, merged: 'e'.repeat(40) },
    };
    const events = [...ordered, ...gauged, ...implementing, merged];
    // Only the moved base has the map: read at the batch's start, nothing would be guarded by it.
    const maps = { [moved]: mapOf('test/**') };
    const { runner, mapReads } = setup({
      events,
      changes: ok(closingDropped),
      maps,
      tip: tips.closing,
    });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(
      end.ending.kind === 'failed' && end.ending.reason,
      'the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, test/add.test.mjs: });',
    );
    assert.deepEqual(mapReads[0], ['acme/api', moved]);
  });

  it("lets no map the proven step committed narrow the base's", async () => {
    const maps = { [gaugeStart]: mapOf('test/**'), [gaugeTip]: mapOf('spec/**') };
    const { runner } = setup({ changes: ok(closingDropped), maps, tip: tips.closing });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(
      end.ending.kind === 'failed' && end.ending.reason,
      'the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, test/add.test.mjs: });',
    );
  });

  it('cancels the attempt when stopped while it reads a test map, and reads no commits', async () => {
    let asked = false;
    const mapAt: ReadTestMapAt = (_repo, _commit, signal) => {
      asked = true;
      // A read asked for once stopped ends at once, as git does on an aborted signal.
      if (signal?.aborted) return Promise.resolve({ kind: 'none' });
      return new Promise((resolve) =>
        signal?.addEventListener('abort', () => resolve({ kind: 'none' })),
      );
    };
    const { runner, calls } = setup({ mapAt });
    const running = runner.start({ ref, limits: defaultLimits });
    while (!asked) await new Promise((resolve) => setImmediate(resolve));
    running.stop();
    const end = await running.ended;
    assert.deepEqual(end.ending, { kind: 'cancelled' });
    assert.deepEqual(calls, []);
  });

  it("a repository with no test map keeps today's testsUnchanged", async () => {
    const maps = { [gaugeStart]: none, [gaugeTip]: none };
    const weakening = setup({ maps });
    const end = await weakening.runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(
      end.ending.kind === 'failed' && end.ending.reason,
      'the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, test/add.test.mjs: assert.equal(add(1, 2), 3);',
    );
    // Without a map the guard keeps declarations and assertions only, as ADR 0078 has it.
    const closing = setup({ changes: ok(closingDropped), maps });
    const ended = await closing.runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(ended.ending.kind, 'succeeded');
  });

  it('the guard still holds against the Finer', async () => {
    const fineStart = 'f'.repeat(40);
    const fine: AttemptRef = { batchId: '12-1', stepId: 'fine', attempt: 1 };
    const events: Event[] = [
      ...ordered,
      ...gauged,
      { type: 'step.scheduled', ...fine, deadlineAt },
      { type: 'step.started', ...fine, worktree: worktree('fine', fineStart) },
    ];
    const { runner, calls } = setup({ events, maps: { [gaugeStart]: mapOf('test/**') } });
    const end = await runner.start({ ref: fine, limits: defaultLimits }).ended;
    assert.equal(
      end.ending.kind === 'failed' && end.ending.reason,
      'the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, test/add.test.mjs: assert.equal(add(1, 2), 3);',
    );
    // The Finer's own commits, from where it started to its branch (ADR 0166).
    assert.ok(
      calls.some(
        ({ args }) => args.includes(fineStart) && args.includes('refs/heads/foedrum/12-1/fine/1'),
      ),
    );
  });
});
