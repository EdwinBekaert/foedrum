// The testsUnchanged guard around the brewer runner (ADR 0017, ADR 0274): once an attempt of a
// guarded step succeeded, it reads from git what the proven step committed and the test files at
// the attempt's branch, and fails the attempt when it changed or removed a line the step added to
// a test file of the test map. Runs with the fake brewer runner and a fake git (ADR 0021).

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
/** The object id the fake clone gives a file at the attempt's tip, or (`c`) where the proven step started. */
const blobOf = (path: string, at = 'b') => `${at}${path.length.toString().padStart(39, '0')}`;

const setup = ({
  events = [...ordered, ...gauged, ...implementing],
  behaviour = behave.succeed(),
  protects = 'gauge' as string | null,
  git: gitOverride,
  maps,
  mapAt,
  tip = tips.weakened,
  before = {},
  listings = {},
  changed = '',
  revList = '',
  platform = 'linux',
}: {
  events?: Event[];
  behaviour?: Behaviour;
  /** `null`: the step has no testsUnchanged guard. */
  protects?: string | null;
  git?: Git;
  /** The test map by commit; absent, the base's map keeps the tests under `test/`. */
  maps?: Readonly<Record<string, MapRead>>;
  /** The test map reader itself, in place of `maps`. */
  mapAt?: ReadTestMapAt;
  /** The files at the attempt's branch, by path: what `ls-tree` lists and `cat-file` reads. */
  tip?: Readonly<Record<string, readonly string[]>>;
  /** The files where the proven step started, by path: what `ls-tree` lists at `gaugeStart`. */
  before?: Readonly<Record<string, readonly string[]>>;
  /** The files `ls-tree` lists at another commit, by commit, in place of `before` and `tip`. */
  listings?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /** The diff of the attempt's own change: every range but the proven step's. */
  changed?: string;
  /** What rev-list lists of the attempt's commits: none, so its change is one stretch. */
  revList?: string;
  /** Whose case rule the guard matches the map's globs by. */
  platform?: NodeJS.Platform;
} = {}) => {
  const mapReads: [string, string][] = [];
  const calls: { cwd: string; args: readonly string[]; options?: GitOptions }[] = [];
  const git: Git =
    gitOverride ??
    ((cwd, args, options) => {
      calls.push({ cwd, args, ...(options === undefined ? {} : { options }) });
      if (args.includes('ls-tree')) {
        const end = args.indexOf('--');
        const commit = args[end - 1] ?? '';
        const started = commit === gaugeStart;
        const files = listings[commit] ?? (started ? before : tip);
        const listed = args.slice(end + 1).filter((path) => files[path] !== undefined);
        const at = started ? 'c' : 'b';
        return Promise.resolve(
          ok(listed.map((path) => `100644 blob ${blobOf(path, at)}\t${path}\0`).join('')),
        );
      }
      if (args.includes('rev-list')) return Promise.resolve(ok(revList));
      if (args.includes('cat-file')) {
        const found = [
          ...Object.entries(tip).map(([path, lines]) => [blobOf(path), lines] as const),
          ...Object.entries(before).map(([path, lines]) => [blobOf(path, 'c'), lines] as const),
        ].find(([blob]) => args.includes(blob));
        const lines = found?.[1];
        return Promise.resolve(
          lines === undefined
            ? { code: 128, stdout: '', stderr: 'fatal: Not a valid object name\n' }
            : ok(`${lines.join('\n')}\n`),
        );
      }
      const from = args[args.indexOf('--') - 2];
      return Promise.resolve(ok(from === gaugeStart ? gaugeDiff : changed));
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
    testMap:
      mapAt ??
      ((repo: string, commit: string) => {
        mapReads.push([repo, commit]);
        return Promise.resolve((maps ?? { [gaugeStart]: mapOf('test/**') })[commit] ?? none);
      }),
    platform,
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
    // In the clone, never the attempt's worktree, whose .git file its brewer can rewrite: the
    // proven step's commits, then its test file at the attempt's branch, which the task tree
    // carries on whatever HEAD is.
    assert.ok(calls.every(({ cwd }) => cwd === clone));
    assert.deepEqual(calls.map(({ args }) => args.join(' ')).slice(0, 2), [
      `${flags} ${gaugeStart} refs/heads/foedrum/12-1/gauge/1 --`,
      '--literal-pathspecs ls-tree -z --full-tree refs/heads/foedrum/12-1/implement/1 -- test/add.test.mjs',
    ]);
    // A large but ordinary change still reads: past the runner's default 4 MiB.
    assert.equal(calls[0]?.options?.maxOutputBytes, 16 * 1024 * 1024);
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
    // The branch of the attempt that made each worktree (ADR 0117).
    const [proven, tip] = calls.map(({ args }) => args.join(' '));
    assert.match(proven ?? '', / -- *$/);
    assert.ok(proven?.includes(`${gaugeStart} refs/heads/foedrum/12-1/gauge/1 --`), proven);
    assert.ok(
      tip?.includes(' ls-tree ') && tip.includes('refs/heads/foedrum/12-1/implement/1 '),
      tip,
    );
  });

  it('lets through a brewer that leaves the red tests as they were (done when, #176)', async () => {
    const { runner } = setup({ tip: tips.kept });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
  });

  it('names how many more lines changed after the first', async () => {
    const { runner } = setup({ tip: { 'test/add.test.mjs': ['});'] } });
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
      git: () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: bad object HEAD\n' }),
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
    const { runner, mapReads } = setup({ maps, tip: tips.closing });
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
    const { runner } = setup({ maps, tip: tips.closing });
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
    const { runner, calls } = setup({ maps, tip: {} });
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
    const kept = setup({ maps, tip: tips.kept });
    const end = await kept.runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
    // The tip's text is read by the object `ls-tree` named, with the diff's bounds.
    const read = kept.calls.find(({ args }) => args.includes('cat-file'));
    assert.deepEqual(read?.args, ['cat-file', 'blob', blobOf('test/add.test.mjs')]);
    assert.equal(read?.options?.maxOutputBytes, 16 * 1024 * 1024);
  });

  it('refuses a removed red line that the file held before the red step too', async () => {
    const maps = { [gaugeStart]: mapOf('test/**') };
    // An older test with the same assertion was there where the Gauger started.
    const older = "test('adds once more', () => assert.equal(add(1, 2), 3));";
    const assertion = '  assert.equal(add(1, 2), 3);';
    const { runner, calls } = setup({
      maps,
      before: { 'test/add.test.mjs': [assertion, older] },
      tip: {
        'test/add.test.mjs': [assertion, older, ...gaugeLines.filter((l) => l !== assertion)],
      },
    });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, failedOn('assert.equal(add(1, 2), 3);'));
    // Read where the proven step started, as at the attempt's tip, by the same ls-tree.
    assert.deepEqual(
      calls.filter(({ args }) => args.includes('ls-tree')).map(({ args }) => args),
      ['refs/heads/foedrum/12-1/implement/1', gaugeStart].map((at) => [
        '--literal-pathspecs',
        'ls-tree',
        '-z',
        '--full-tree',
        at,
        '--',
        'test/add.test.mjs',
      ]),
    );
  });

  it('is blocked on the environment when a test file cannot be read at the tip', async () => {
    const maps = { [gaugeStart]: mapOf('test/**') };
    const git: Git = (_cwd, args) =>
      Promise.resolve(
        args.includes('ls-tree')
          ? { code: 128, stdout: '', stderr: 'fatal: not a tree object\n' }
          : ok(gaugeDiff),
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
  /** A clone whose ls-tree at the attempt's branch names the red test file and `listed`. */
  const tipGit =
    (listed: string[], read: (blob: string) => GitResult, calls: string[][] = []): Git =>
    (_cwd, args) => {
      calls.push([...args]);
      if (args.includes('ls-tree')) {
        const atTip = args.includes('refs/heads/foedrum/12-1/implement/1');
        const names = atTip ? listed : [];
        return Promise.resolve(
          ok(names.map((path) => `100644 blob ${blobOf(path)}\t${path}\0`).join('')),
        );
      }
      if (args.includes('cat-file')) return Promise.resolve(read(args.at(-1) ?? ''));
      return Promise.resolve(ok(gaugeDiff));
    };

  it('is blocked on the environment when git cannot read a test file it listed at the tip', async () => {
    const maps = { [gaugeStart]: mapOf('test/**') };
    const failed = { code: 128, stdout: '', stderr: 'fatal: unable to read blob\n' };
    const git = tipGit(['test/add.test.mjs'], () => failed);
    const { runner } = setup({ maps, git });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard testsUnchanged cannot read the commits of step implement: fatal: unable to read blob',
    });
  });

  it('reads no file ls-tree lists past the paths it asked for', async () => {
    const maps = { [gaugeStart]: mapOf('test/**') };
    const calls: string[][] = [];
    const text = (lines: readonly string[]) => ok(`${lines.join('\n')}\n`);
    const git = tipGit(
      ['test/add.test.mjs', 'test/other.test.mjs'],
      (blob) => text(blob === blobOf('test/add.test.mjs') ? gaugeLines : ['other']),
      calls,
    );
    const { runner } = setup({ maps, git });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(
      calls.filter((args) => args.includes('cat-file')),
      [['cat-file', 'blob', blobOf('test/add.test.mjs')]],
    );
  });

  it("matches the map's globs in either case where the platform folds case", async () => {
    const maps = { [gaugeStart]: mapOf('TEST/**') };
    const folding = setup({
      maps,
      platform: 'win32',
      tip: tips.closing,
    });
    const end = await folding.runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(
      end.ending.kind === 'failed' && end.ending.reason,
      'the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, test/add.test.mjs: });',
    );
    const exact = setup({ maps, tip: tips.closing });
    const ended = await exact.runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(ended.ending.kind, 'succeeded');
  });

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
    const { runner } = setup({ maps, tip: tips.closing });
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

  it('blocks the guard on its environment when neither the base nor the proven step has a test map', async () => {
    const maps = { [gaugeStart]: none, [gaugeTip]: none };
    const { runner } = setup({ maps });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard testsUnchanged finds no test map of acme/api where the batch started or at the tip of step gauge',
    });
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
    // The red test file at the Finer's own branch (ADR 0166).
    assert.ok(
      calls.some(
        ({ args }) => args.includes('ls-tree') && args.includes('refs/heads/foedrum/12-1/fine/1'),
      ),
    );
  });
});

describe('guardTests on the test files the base holds (ADR 0358)', () => {
  const older = 'test/older.test.mjs';
  /** A diff of the attempt that changes an assertion in each of `paths`. */
  const changing = (...paths: string[]) =>
    paths
      .flatMap((path) => [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -2 +2 @@',
        '-  assert.equal(add(1, 2), 3);',
        "+  assert.equal(add(1, 2), 'three');",
      ])
      .concat('')
      .join('\n');
  const flags =
    '-c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --text --no-renames --unified=0 --src-prefix=a/ --dst-prefix=b/';

  it("fails an attempt that changed a test file the batch's base holds, naming it", async () => {
    const before = { [older]: ['  assert.equal(add(1, 2), 3);'] };
    const { calls, runner } = setup({ tip: tips.kept, before, changed: changing(older) });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason:
        "the guard testsUnchanged: the attempt changed a test file the batch's base holds, test/older.test.mjs: a test that must change goes back to the Gauger as a finding",
    });
    const asked = calls.map(({ args }) => args.join(' '));
    // Its own change, from where it started to its branch, in the clone.
    assert.ok(asked.includes(`${flags} ${implementStart} refs/heads/foedrum/12-1/implement/1 --`));
    assert.ok(
      asked.includes(`--literal-pathspecs ls-tree -z --full-tree ${gaugeStart} -- ${older}`),
    );
    assert.ok(calls.every(({ cwd }) => cwd === clone));
  });

  it('names how many more test files the base holds it changed', async () => {
    const before = { [older]: ['a'], 'test/other.test.mjs': ['b'] };
    const changed = changing(older, 'test/other.test.mjs');
    const { runner } = setup({ tip: tips.kept, before, changed });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(
      end.ending.kind === 'failed' && end.ending.reason,
      "the guard testsUnchanged: the attempt changed 2 test files the batch's base holds, test/older.test.mjs (and 1 more): a test that must change goes back to the Gauger as a finding",
    );
  });

  it('lets an attempt change a test file the base does not hold, beside the red tests', async () => {
    const changed = changing('test/new.test.mjs', 'test/add.test.mjs');
    const { calls, runner } = setup({ tip: tips.kept, changed });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
    // It asked the base for them, and the base holds neither.
    const listed = `${gaugeStart} -- test/new.test.mjs test/add.test.mjs`;
    assert.ok(calls.some(({ args }) => args.join(' ').endsWith(listed)));
  });

  it('lets an attempt change code the base holds', async () => {
    const before = { 'src/add.mjs': ['export const add = () => 0;'] };
    const { runner } = setup({ tip: tips.kept, before, changed: changing('src/add.mjs') });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
  });

  it("reads the attempt's change from its start merge, against the moved base (ADR 0244)", async () => {
    const moved = 'd'.repeat(40);
    const mergedAt = 'e'.repeat(40);
    const merged: Event = {
      type: 'effect.applied',
      key: effectKey.encode(baseMergeKey(ref)),
      result: { base: moved, merged: mergedAt },
    };
    const { calls, runner } = setup({
      events: [...ordered, ...gauged, ...implementing, merged],
      maps: { [moved]: mapOf('test/**') },
      tip: tips.kept,
      listings: { [moved]: { [older]: ['a'] } },
      changed: changing(older),
      revList: `${mergedAt} ${implementStart} ${moved}\n`,
    });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'failed');
    const asked = calls.map(({ args }) => args.join(' '));
    assert.ok(asked.includes(`${flags} ${mergedAt} refs/heads/foedrum/12-1/implement/1 --`));
  });

  it('is blocked on the environment when git cannot read the base', async () => {
    const tipFile = `100644 blob ${blobOf('test/add.test.mjs')}\ttest/add.test.mjs\0`;
    const base: Git = (_cwd, args) => {
      if (args.includes('ls-tree') && args.includes(older)) {
        return Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a tree object\n' });
      }
      // Where the proven step started, the red test file was not yet.
      if (args.includes('ls-tree') && args.includes(gaugeStart)) return Promise.resolve(ok(''));
      if (args.includes('ls-tree')) return Promise.resolve(ok(tipFile));
      if (args.includes('cat-file')) return Promise.resolve(ok(`${gaugeLines.join('\n')}\n`));
      const from = args[args.indexOf('--') - 2];
      return Promise.resolve(ok(from === gaugeStart ? gaugeDiff : changing(older)));
    };
    const { runner } = setup({ git: base });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard testsUnchanged cannot read the commits of step implement: fatal: not a tree object',
    });
  });

  it("reads the attempt's change after the merge it concluded, when its start merge kept a conflict (ADR 0244)", async () => {
    const moved = 'd'.repeat(40);
    const concluded = 'f'.repeat(40);
    const kept: Event = {
      type: 'effect.applied',
      key: effectKey.encode(baseMergeKey(ref)),
      result: {
        base: moved,
        kept: { files: [{ path: 'src/add.mjs', status: 'both modified' }], more: 0 },
      },
    };
    const calls: string[] = [];
    const git: Git = (_cwd, args) => {
      calls.push(args.join(' '));
      if (args.includes('rev-list')) {
        // The brewer's commit after the merge it concluded, then the merge, newest first.
        return Promise.resolve(
          ok(`${'9'.repeat(40)} ${concluded}\n${concluded} ${implementStart} ${moved}\n`),
        );
      }
      if (args.includes('ls-tree') && args.includes(older)) {
        return Promise.resolve(ok(`100644 blob ${blobOf(older, 'c')}\t${older}\0`));
      }
      if (args.includes('ls-tree') && args.includes(gaugeStart)) return Promise.resolve(ok(''));
      if (args.includes('ls-tree')) {
        return Promise.resolve(
          ok(`100644 blob ${blobOf('test/add.test.mjs')}\ttest/add.test.mjs\0`),
        );
      }
      if (args.includes('cat-file')) return Promise.resolve(ok(`${gaugeLines.join('\n')}\n`));
      const from = args[args.indexOf('--') - 2];
      // The moved base changed the older test; the brewer changed only code after the merge.
      if (from === gaugeStart) return Promise.resolve(ok(gaugeDiff));
      return Promise.resolve(ok(from === concluded ? changing('src/add.mjs') : changing(older)));
    };
    const { runner } = setup({ events: [...ordered, ...gauged, ...implementing, kept], git });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.ok(calls.includes(`${flags} ${concluded} refs/heads/foedrum/12-1/implement/1 --`));
  });

  it('asks the base only for the files the attempt changed in a test area', async () => {
    const before = { [older]: ['a'] };
    const changed = changing('src/add.mjs', older);
    const { calls, runner } = setup({ tip: tips.kept, before, changed });
    await runner.start({ ref, limits: defaultLimits }).ended;
    const listed = calls
      .map(({ args }) => args.join(' '))
      .filter(
        (args) => args.includes(`ls-tree -z --full-tree ${gaugeStart} --`) && args.includes(older),
      );
    assert.deepEqual(listed, [
      `--literal-pathspecs ls-tree -z --full-tree ${gaugeStart} -- ${older}`,
    ]);
  });
});

describe('guardTests after a start merge that kept a conflict (ADR 0358, ADR 0244)', () => {
  const older = 'test/older.test.mjs';
  const moved = 'd'.repeat(40);
  const flags =
    '-c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --text --no-renames --unified=0 --src-prefix=a/ --dst-prefix=b/';
  const kept: Event = {
    type: 'effect.applied',
    key: effectKey.encode(baseMergeKey(ref)),
    result: {
      base: moved,
      kept: { files: [{ path: 'src/add.mjs', status: 'both modified' }], more: 0 },
    },
  };
  /** A clone whose rev-list answers `revList`, and whose diffs from `from` list `older`. */
  const cloneWith = (revList: GitResult, olderFrom: string) => {
    const calls: string[] = [];
    const git: Git = (_cwd, args) => {
      calls.push(args.join(' '));
      if (args.includes('rev-list')) return Promise.resolve(revList);
      if (args.includes('ls-tree') && args.includes(older)) {
        return Promise.resolve(ok(`100644 blob ${blobOf(older, 'c')}\t${older}\0`));
      }
      if (args.includes('ls-tree') && args.includes(gaugeStart)) return Promise.resolve(ok(''));
      if (args.includes('ls-tree')) {
        const listed = `100644 blob ${blobOf('test/add.test.mjs')}\ttest/add.test.mjs\0`;
        return Promise.resolve(ok(listed));
      }
      if (args.includes('cat-file')) return Promise.resolve(ok(`${gaugeLines.join('\n')}\n`));
      const from = args[args.indexOf('--') - 2];
      if (from === gaugeStart) return Promise.resolve(ok(gaugeDiff));
      const path = from === olderFrom ? older : 'src/add.mjs';
      return Promise.resolve(
        ok(
          [
            `diff --git a/${path} b/${path}`,
            `--- a/${path}`,
            `+++ b/${path}`,
            '@@ -2 +2 @@',
            '-a',
            '+b',
            '',
          ].join('\n'),
        ),
      );
    };
    return { calls, git };
  };
  const events = [...ordered, ...gauged, ...implementing, kept];

  it('reads each stretch between the merges the brewer made, never a merge of its own', async () => {
    const [newer, between, oldest] = ['f'.repeat(40), '9'.repeat(40), 'e'.repeat(40)];
    const listed = `${newer} ${between} ${moved}\n${between} ${oldest}\n${oldest} ${implementStart} ${moved}\n`;
    const { calls, git } = cloneWith(ok(listed), implementStart);
    const { runner } = setup({ events, git });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
    const diffs = calls.filter((call) => call.startsWith(flags) && !call.includes(gaugeStart));
    assert.deepEqual(diffs, [
      `${flags} ${oldest} ${between} --`,
      `${flags} ${newer} refs/heads/foedrum/12-1/implement/1 --`,
    ]);
  });

  it('reads the commits the brewer made before a merge, as its own', async () => {
    const [merge, before] = ['f'.repeat(40), 'e'.repeat(40)];
    const listed = `${merge} ${before} ${moved}\n${before} ${implementStart}\n`;
    const { calls, git } = cloneWith(ok(listed), implementStart);
    const { runner } = setup({ events, git });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'failed');
    assert.ok(calls.includes(`${flags} ${implementStart} ${before} --`));
  });

  it("reads a resumed attempt's change after the merge it made, which the ledger keeps under it", async () => {
    const merge = 'f'.repeat(40);
    const session = { id: 'implement-session', worktree: join(root, 'implement', '1') };
    const resumed: Event[] = [
      { type: 'step.scheduled', ...ref, deadlineAt },
      { type: 'step.started', ...ref, session, worktree: worktree('implement', implementStart) },
      {
        type: 'step.finished',
        ...ref,
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
        claude: { version: '2.1.301', model: 'claude-sonnet-5-5' },
      },
      { type: 'step.scheduled', ...ref, attempt: 2, deadlineAt, retry: true },
      { type: 'step.started', ...ref, attempt: 2, session: { ...session, resumes: session.id } },
      {
        type: 'effect.applied',
        key: effectKey.encode(baseMergeKey({ ...ref, attempt: 2 })),
        result: { base: moved, merged: merge },
      },
    ];
    const { git } = cloneWith(ok(`${merge} ${implementStart} ${moved}\n`), implementStart);
    const maps = { [moved]: mapOf('test/**') };
    const { runner } = setup({ events: [...ordered, ...gauged, ...resumed], git, maps });
    const end = await runner.start({ ref: { ...ref, attempt: 2 }, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'succeeded');
  });

  it('reads the change from where the attempt started when no commit merged the moved base', async () => {
    const { calls, git } = cloneWith(ok(`${'9'.repeat(40)} ${implementStart}\n`), implementStart);
    const { runner } = setup({ events, git });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.equal(end.ending.kind, 'failed');
    assert.ok(calls.includes(`${flags} ${implementStart} refs/heads/foedrum/12-1/implement/1 --`));
  });

  it('is blocked on the environment when git cannot list the commits', async () => {
    const failed = { code: 128, stdout: '', stderr: 'fatal: bad revision\n' };
    const { git } = cloneWith(failed, implementStart);
    const { runner } = setup({ events, git });
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard testsUnchanged cannot read the commits of step implement: fatal: bad revision',
    });
  });
});
