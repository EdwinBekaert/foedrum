// The red proof in the check runner (ADR 0017, ADR 0078): it runs the repository's test check in
// the attempt's worktree, reads the structured test report, never the exit code, and the tests the
// proven step committed from git, through an injected process runner and git (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { OutDocRead } from '../../src/brewers/claude-runner.ts';
import { createCheckRunner, type ReportFiles } from '../../src/checks/check-runner.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';
import type { MapRead } from '../../src/checks/test-map.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import type { TestReportConfig } from '../../src/schemas/brewery-config.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { TestMapModule } from '../../src/schemas/test-map.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';

const root = join('/work', 'acme.api', 'attempts', '12-1');
const gaugeTree = join(root, 'gauge', '1');
const redTree = join(root, 'red', '1');
const clone = join('/work', 'acme.api', 'clone.git');
const ref = { batchId: '12-1', stepId: 'red', attempt: 1 };
const now = new Date('2026-10-18T12:00:00.000Z');
const deadlineAt = '2026-10-18T12:30:00.000Z';
const gaugeStart = 'a'.repeat(40);

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
    worktree: {
      repo: 'acme/api',
      path: gaugeTree,
      branch: 'foedrum/12-1/gauge/1',
      commit: gaugeStart,
    },
  },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'gauge',
    attempt: 1,
    outcome: { kind: 'succeeded', output: null },
  },
];
const redStarted: Event[] = [
  { type: 'step.scheduled', ...ref, deadlineAt },
  {
    type: 'step.started',
    ...ref,
    worktree: {
      repo: 'acme/api',
      path: redTree,
      branch: 'foedrum/12-1/red/1',
      commit: 'b'.repeat(40),
    },
  },
];

const repository: RepositoryChecks = {
  build: null,
  typecheck: null,
  lint: null,
  format: null,
  test: 'npm test',
};

// The Gauger's commit: a test and a stub that throws.
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

const stubFails = [
  'TAP version 13',
  'not ok 1 - adds two numbers',
  '  ---',
  "  error: 'not implemented'",
  '  ...',
  'ok 2 - subtracts',
  '1..2',
].join('\n');

const compileError = [
  'TAP version 13',
  "# SyntaxError: The requested module '../src/add.mjs' does not provide an export named 'add'",
  'not ok 1 - test/add.test.mjs',
  '  ---',
  "  error: 'test failed'",
  '  ...',
  '1..1',
].join('\n');

const setup = ({
  events = [...ordered, ...gauged, ...redStarted],
  /** `null`: foedrum.jsonc gives the repository none. */
  report = { format: 'tap' } as TestReportConfig | null,
  test = { exitCode: 1, stdout: stubFails } as Partial<ExecResult>,
  diff = { code: 0, stdout: gaugeDiff, stderr: '' } as GitResult,
  files = {} as Record<string, OutDocRead>,
  checks: repositoryChecks = repository,
  /** Why clearing the report fails, when it does. */
  clearFails = undefined as string | undefined,
  platform = 'linux' as NodeJS.Platform,
  /** The repository's setup command, when it has one (ADR 0140). */
  prepare = undefined as string | undefined,
  /** The setup's exit code. */
  prepareExit = 0,
  /** The text of a file at the proven step's tip, by `<rev>:<path>`; git finds no other. */
  tips = {} as Record<string, string>,
  /** The files at the tip whose read git was killed for, by `<rev>:<path>`. */
  killedTips = [] as string[],
  /** The test map at each commit, when the runner reads maps (ADR 0274). */
  maps = undefined as Record<string, MapRead> | undefined,
  /** The paths each report pattern of the map finds in the worktree, by pattern. */
  found = {} as Record<string, string[]>,
  /** Why a report pattern is refused, by pattern. */
  refusedPatterns = {} as Record<string, string>,
  /** What git lists of the files the batch deleted since its base, NUL-separated, or its failure. */
  deleted = '' as string | GitResult,
  /** What git lists of the files at the base, NUL-separated, or its failure. */
  atBase = '' as string | GitResult,
  /** The worktree's real path: no link leads to it unless the test says so. */
  realPathOf = (path: string) => path,
} = {}) => {
  const listed = (answer: string | GitResult): GitResult =>
    typeof answer === 'string' ? { code: 0, stdout: answer, stderr: '' } : answer;
  const order: string[] = [];
  const execOptions: ExecOptions[] = [];
  const exec: ExecProcess = (file, _args, options) => {
    execOptions.push(options);
    order.push(`exec ${file} in ${options.cwd}`);
    const stdout = test.stdout ?? '';
    return Promise.resolve({ exitCode: 0, stdout, stderr: '', output: stdout, ...test });
  };
  const git: Git = (cwd, args) => {
    order.push(`git ${args.join(' ')} in ${cwd}`);
    if (args.includes('--diff-filter=D')) return Promise.resolve(listed(deleted));
    if (args[0] === 'ls-tree') return Promise.resolve(listed(atBase));
    if (args[0] !== 'cat-file') return Promise.resolve(diff);
    if (killedTips.includes(args.at(-1) ?? '')) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', killed: 'timed-out' as const });
    }
    const tip = tips[args.at(-1) ?? ''];
    return Promise.resolve(
      tip === undefined
        ? { code: 128, stdout: '', stderr: 'fatal: path does not exist\n' }
        : { code: 0, stdout: tip, stderr: '' },
    );
  };
  const reports: ReportFiles = {
    clear: (file) => {
      order.push(`clear ${file}`);
      if (clearFails !== undefined) throw new Error(clearFails);
    },
    read: (file, inside) => {
      order.push(`read ${file} inside ${inside}`);
      return files[file] ?? { kind: 'missing' };
    },
  };
  const checks: StepChecks = {
    find: (recipe, stepId) => (recipe === 'nip' && stepId === 'red' ? ['test'] : undefined),
    any: () => true,
    proves: (recipe, stepId) => (recipe === 'nip' && stepId === 'red' ? 'gauge' : undefined),
    redProof: (recipe) => (recipe === 'nip' ? { id: 'red', of: 'gauge' } : undefined),
  };
  const runner = createCheckRunner({
    state: () => fold(events),
    checks,
    repositoryChecks: () => repositoryChecks,
    testReport: () => report ?? undefined,
    exec,
    setup: {
      of: () => (prepare === undefined ? undefined : { command: prepare, timeout: '10m' }),
      exec: (file, _args, options) => {
        order.push(`setup ${file} in ${options.cwd}`);
        return Promise.resolve({
          exitCode: prepareExit,
          stdout: '',
          stderr: '',
          output: 'added 1\n',
        });
      },
    },
    git,
    clone: (repo) => (repo === 'acme/api' ? clone : join('/work', 'other')),
    reports,
    env: { base: {}, forced: {} },
    clock: () => now,
    platform,
    ...(maps === undefined
      ? {}
      : {
          testMap: {
            at: async (_repo: string, commit: string) => maps[commit] ?? { kind: 'none' as const },
            reports: (pattern: string, inside: string) => {
              order.push(`find ${pattern} in ${inside}`);
              const why = refusedPatterns[pattern];
              return why === undefined ? { paths: found[pattern] ?? [] } : { refused: why };
            },
            realPath: realPathOf,
          },
        }),
  });
  const run = () =>
    runner.start({ ref, limits: { outDoc: { file: 'out.md', schema: undefined as never } } }).ended;
  return { order, run, execOptions };
};

const failedWith = (reason: string) => ({ kind: 'failed', retryable: false, reason });

describe('createCheckRunner: the red proof (ADR 0078)', () => {
  it("proves red the proven step's tests from TAP on stdout, with the step's commits from git", async () => {
    const { order, run, execOptions } = setup();
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    // TAP on stdout may be as large as a report file: 16 MiB, past the runner's default 4 MiB.
    assert.equal(execOptions[0]?.maxOutputBytes, 16 * 1024 * 1024);
    assert.deepEqual(
      end.readings?.map((reading) => [reading.result, 'exitCode' in reading && reading.exitCode]),
      [['exited', 1]],
    );
    assert.deepEqual(order, [
      `git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --text --no-renames --unified=0 --src-prefix=a/ --dst-prefix=b/ ${gaugeStart} refs/heads/foedrum/12-1/gauge/1 -- in ${clone}`,
      `exec npm test in ${redTree}`,
    ]);
  });

  it("runs the repository's setup in the worktree before the red run (ADR 0140)", async () => {
    const { order, run } = setup({ prepare: 'npm ci' });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(
      order.filter((line) => !line.startsWith('git')),
      [`setup npm ci in ${redTree}`, `exec npm test in ${redTree}`],
    );
    assert.deepEqual(
      end.readings?.map((reading) => [reading.result, 'setup' in reading && reading.setup]),
      [
        ['exited', true],
        ['exited', false],
      ],
    );
  });

  it('runs no setup for a red proof that is blocked before its run: no test report (ADR 0140)', async () => {
    const { order, run } = setup({ prepare: 'npm ci', report: null });
    const end = await run();
    assert.equal(end.ending.kind, 'blocked');
    assert.deepEqual(order, []);
  });

  it("runs no setup when the proven step's commits cannot be read (ADR 0140)", async () => {
    const { order, run } = setup({
      prepare: 'npm ci',
      diff: { code: 128, stdout: '', stderr: 'bad' },
    });
    const end = await run();
    assert.equal(end.ending.kind, 'blocked');
    assert.ok(
      order.every((line) => !line.startsWith('setup')),
      order.join('\n'),
    );
  });

  it("runs the setup after the proven step's commits are read and before the report is cleared (ADR 0140)", async () => {
    const results = join(redTree, 'build', 'results.xml');
    const xml =
      '<testsuite><testcase name="adds two numbers"><failure message="not implemented"/></testcase></testsuite>';
    const { order, run } = setup({
      prepare: 'npm ci',
      report: { format: 'junit', path: 'build/results.xml' },
      files: { [results]: { kind: 'text', text: xml } },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.ok(order[0]?.startsWith('git '), order[0]);
    assert.deepEqual(order.slice(1), [
      `setup npm ci in ${redTree}`,
      `clear ${results}`,
      `exec npm test in ${redTree}`,
      `read ${results} inside ${redTree}`,
    ]);
  });

  it('ends a red proof on its environment, clearing and running nothing, when the setup fails (ADR 0140)', async () => {
    const { order, run } = setup({
      prepare: 'npm ci',
      prepareExit: 1,
      report: { format: 'junit', path: 'build/results.xml' },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the setup "npm ci" failed with exit code 1',
    });
    assert.deepEqual(order.slice(1), [`setup npm ci in ${redTree}`]);
    assert.deepEqual(
      end.readings?.map((reading) => 'setup' in reading && reading.setup),
      [true],
    );
  });

  it('says on native Windows that the red run ran unsandboxed (ADR 0076)', async () => {
    const end = await setup({ platform: 'win32' }).run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(
      end.readings?.map((reading) => 'unsandboxed' in reading && reading.unsandboxed),
      [true],
    );
    const elsewhere = await setup().run();
    assert.deepEqual(
      elsewhere.readings?.map((reading) => 'unsandboxed' in reading),
      [false],
    );
  });

  it("reads the proven step's commits from its first attempt's start, after a route sent it back", async () => {
    // The second attempt starts at the first's commits: its own diff would miss the first's tests.
    const again: Event[] = [
      { type: 'step.scheduled', batchId: '12-1', stepId: 'gauge', attempt: 2, deadlineAt },
      {
        type: 'step.started',
        batchId: '12-1',
        stepId: 'gauge',
        attempt: 2,
        worktree: {
          repo: 'acme/api',
          path: join(root, 'gauge', '2'),
          branch: 'foedrum/12-1/gauge/2',
          commit: 'd'.repeat(40),
        },
      },
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'gauge',
        attempt: 2,
        outcome: { kind: 'succeeded', output: null },
      },
    ];
    const { order, run } = setup({ events: [...ordered, ...gauged, ...again, ...redStarted] });
    await run();
    assert.match(
      order[0] ?? '',
      new RegExp(` ${gaugeStart} refs/heads/foedrum/12-1/gauge/2 -- in `),
    );
  });

  it("reads the proven step's commits on the branch of the worktree its resumed attempt ran in (#327, ADR 0117)", async () => {
    const [scheduled, started] = gauged;
    assert.ok(started?.type === 'step.started');
    const gauge = (attempt: number) => ({ batchId: '12-1', stepId: 'gauge', attempt });
    const claude = { version: '2.1.301', model: 'claude-sonnet-5-5' };
    const session = { id: 'gauge-session', worktree: gaugeTree };
    const resumed: Event[] = [
      ...(scheduled === undefined ? [] : [scheduled]),
      { ...started, session },
      {
        type: 'step.finished',
        ...gauge(1),
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
        claude,
      },
      { type: 'step.scheduled', ...gauge(2), deadlineAt, retry: true },
      // No worktree of its own: it ran in gauge#1's (ADR 0029).
      { type: 'step.started', ...gauge(2), session: { ...session, resumes: session.id } },
      { type: 'step.finished', ...gauge(2), outcome: { kind: 'succeeded', output: null }, claude },
    ];
    const { order, run } = setup({ events: [...ordered, ...resumed, ...redStarted] });
    await run();
    assert.match(
      order[0] ?? '',
      new RegExp(` ${gaugeStart} refs/heads/foedrum/12-1/gauge/1 -- in `),
    );
  });

  it('rejects a red run that fails on a compile error (done when, #176)', async () => {
    const { run } = setup({ test: { exitCode: 1, stdout: compileError } });
    const end = await run();
    // The test check's reading is kept on a failed red proof too.
    assert.deepEqual(
      end.readings?.map((reading) => [reading.result, 'exitCode' in reading && reading.exitCode]),
      [['exited', 1]],
    );
    assert.deepEqual(
      end.ending,
      failedWith(
        "the red proof of step gauge failed: the run has a load, compile, import or collection error: SyntaxError: The requested module '../src/add.mjs' does not provide an export named 'add'",
      ),
    );
  });

  it('reads the report, never the exit code: a passing exit proves nothing, a failing one decides nothing', async () => {
    const passing = await setup({ test: { exitCode: 0, stdout: stubFails } }).run();
    assert.deepEqual(passing.ending, { kind: 'succeeded', output: null });
    const green = 'ok 1 - adds two numbers\n1..1\n';
    const failing = await setup({ test: { exitCode: 1, stdout: green } }).run();
    assert.deepEqual(
      failing.ending,
      failedWith(
        'the red proof of step gauge failed: test "adds two numbers" passes before the implementation: a stub must throw, not return a value',
      ),
    );
  });

  it("accepts the regression tests the proven step's latest success names in its out doc (ADR 0170)", async () => {
    const [scheduled, started, finished] = gauged;
    assert.ok(finished?.type === 'step.finished' && scheduled && started);
    const output = {
      status: 'done',
      summary: 'Tests for add',
      assumptions: [],
      tests: ['adds two numbers'],
      regressionTests: ['keeps subtracting'],
    };
    const named: Event = { ...finished, outcome: { kind: 'succeeded', output } };
    const diff = [
      gaugeDiff.trimEnd(),
      'diff --git a/test/sub.test.mjs b/test/sub.test.mjs',
      '--- /dev/null',
      '+++ b/test/sub.test.mjs',
      '@@ -0,0 +1,3 @@',
      "+test('keeps subtracting', () => {",
      '+  assert.equal(sub(2, 1), 1);',
      '+});',
      '',
    ].join('\n');
    const stdout = stubFails.replace('ok 2 - subtracts', 'ok 2 - keeps subtracting');
    const events = [...ordered, scheduled, started, named, ...redStarted];
    const { run } = setup({
      events,
      test: { exitCode: 1, stdout },
      diff: { code: 0, stdout: diff, stderr: '' },
    });
    assert.deepEqual((await run()).ending, { kind: 'succeeded', output: null });
    // Without the name, the passing test the step added fails the proof, as before.
    const unnamed = setup({
      test: { exitCode: 1, stdout },
      diff: { code: 0, stdout: diff, stderr: '' },
    });
    assert.deepEqual(
      (await unnamed.run()).ending,
      failedWith(
        'the red proof of step gauge failed: test "keeps subtracting" passes before the implementation: a stub must throw, not return a value',
      ),
    );
    // A Gauger sent back names its tests again: the latest success's names count, as its commits do.
    const gauge2 = { batchId: '12-1', stepId: 'gauge', attempt: 2 };
    const stale: Event = {
      ...finished,
      outcome: { kind: 'succeeded', output: { ...output, regressionTests: ['keeps dividing'] } },
    };
    const again: Event[] = [
      { type: 'step.scheduled', ...gauge2, deadlineAt },
      {
        type: 'step.started',
        ...gauge2,
        worktree: {
          repo: 'acme/api',
          path: join(root, 'gauge', '2'),
          branch: 'foedrum/12-1/gauge/2',
          commit: 'd'.repeat(40),
        },
      },
      { type: 'step.finished', ...gauge2, outcome: { kind: 'succeeded', output } },
    ];
    const latest = setup({
      events: [...ordered, scheduled, started, stale, ...again, ...redStarted],
      test: { exitCode: 1, stdout },
      diff: { code: 0, stdout: diff, stderr: '' },
    });
    assert.deepEqual((await latest.run()).ending, { kind: 'succeeded', output: null });
  });

  it('reads a JUnit report from its file, cleared before the test command runs', async () => {
    const results = join(redTree, 'build', 'results.xml');
    const xml =
      '<testsuite><testcase name="adds two numbers"><failure message="not implemented"/></testcase></testsuite>';
    const { order, run } = setup({
      report: { format: 'junit', path: 'build/results.xml' },
      files: { [results]: { kind: 'text', text: xml } },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(order.slice(1), [
      `clear ${results}`,
      `exec npm test in ${redTree}`,
      `read ${results} inside ${redTree}`,
    ]);
  });

  it('fails when the test command wrote no report, or one that cannot be read', async () => {
    const tapFile = { format: 'tap', path: 'tap.txt' } as const;
    const missing = await setup({ report: tapFile }).run();
    assert.deepEqual(
      missing.ending,
      failedWith(
        'the red proof of step gauge failed: the test command wrote no test report at tap.txt',
      ),
    );
    const linked = await setup({
      report: tapFile,
      files: {
        [join(redTree, 'tap.txt')]: { kind: 'unread', reason: 'it is outside the worktree' },
      },
    }).run();
    assert.deepEqual(
      linked.ending,
      failedWith(
        'the red proof of step gauge failed: the test report tap.txt cannot be read: it is outside the worktree',
      ),
    );
    const garbage = await setup({ test: { exitCode: 1, stdout: 'Error: npm not found' } }).run();
    assert.deepEqual(
      garbage.ending,
      failedWith(
        'the red proof of step gauge failed: the test report on stdout is not TAP: it has no TAP test point',
      ),
    );
  });

  it('is blocked on the environment, running nothing, when the old report cannot be cleared', async () => {
    const { order, run } = setup({
      report: { format: 'junit', path: 'build/results.xml' },
      clearFails: "EISDIR: illegal operation on a directory, rm 'build/results.xml'",
    });
    // The attempt ends with an outcome; it never rejects.
    const end = await run().catch((error: Error) => ({ ending: { rejected: error.message } }));
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        "the test report build/results.xml cannot be cleared: EISDIR: illegal operation on a directory, rm 'build/results.xml'",
    });
    assert.ok(
      order.every((line) => !line.startsWith('exec')),
      order.join('\n'),
    );
  });

  it('settles a test command that did not exit as any check does (ADR 0069)', async () => {
    const end = await setup({ test: { exitCode: null, killed: 'timed-out', stdout: '' } }).run();
    assert.deepEqual(
      end.ending,
      failedWith('the check "test" (npm test) did not finish by the step\'s deadline'),
    );
  });

  it('is blocked on the environment, running nothing, when the repository has no test report', async () => {
    const { order, run } = setup({ report: null });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'recipe nip proves its tests red, which needs the test report of acme/api: add "testReport" to its entry in foedrum.jsonc, { "format": "tap" } or { "format": "junit", "path": "<file>" } (ADR 0017)',
    });
    assert.deepEqual(order, []);
  });

  it('is blocked on the environment, running nothing, when the repository has no test check', async () => {
    const { order, run } = setup({ checks: { ...repository, test: null } });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'foedrum.jsonc gives acme/api no test check',
    });
    assert.ok(
      order.every((line) => !line.startsWith('exec')),
      order.join('\n'),
    );
  });

  it('is blocked on a divergence when the proven step has no attempt that succeeded', async () => {
    const { order, run } = setup({ events: [...ordered, ...redStarted] });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'divergence',
      summary: 'step red proves the tests of step gauge, which has no attempt that succeeded',
    });
    assert.deepEqual(order, []);
  });

  // The Gauger adds a row to a table its test file declared before: no added line declares a test.
  const rowDiff = [
    'diff --git a/test/sum.test.mjs b/test/sum.test.mjs',
    '--- a/test/sum.test.mjs',
    '+++ b/test/sum.test.mjs',
    '@@ -3,0 +4 @@',
    "+  ['adds negatives', -1, -2, -3],",
    '',
  ].join('\n');
  const rowFails = [
    'TAP version 13',
    'not ok 1 - adds negatives',
    '  ---',
    "  error: 'not implemented'",
    '  ...',
    '1..1',
  ].join('\n');
  const gaugeTip = 'refs/heads/foedrum/12-1/gauge/1';

  it("reads a file the step's added lines declare no test in at its tip, and takes the row it added (#661)", async () => {
    const { order, run } = setup({
      diff: { code: 0, stdout: rowDiff, stderr: '' },
      test: { exitCode: 1, stdout: rowFails },
      tips: {
        [`${gaugeTip}:test/sum.test.mjs`]:
          "test.each([\n  ['adds', 1, 2, 3],\n])('%s', (_, a, b, sum) => {\n",
      },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(
      order.filter((line) => line.startsWith('git cat-file')),
      [`git cat-file blob ${gaugeTip}:test/sum.test.mjs in ${clone}`],
    );
  });

  it('is blocked on the environment when git was killed reading a file at the tip', async () => {
    const { run } = setup({
      diff: { code: 0, stdout: rowDiff, stderr: '' },
      test: { exitCode: 1, stdout: rowFails },
      killedTips: [`${gaugeTip}:test/sum.test.mjs`],
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the files of step gauge at its tip cannot be read: git cat-file of test/sum.test.mjs was killed (timed-out)',
    });
  });

  it('takes no file git cannot read at the tip for a test file: its row is no test the step added', async () => {
    const { run } = setup({
      diff: { code: 0, stdout: rowDiff, stderr: '' },
      test: { exitCode: 1, stdout: rowFails },
    });
    const end = await run();
    assert.deepEqual(
      end.ending,
      failedWith(
        'the red proof of step gauge failed: none of the 1 tests in the report is one the step added',
      ),
    );
  });

  it('reads no file the step deleted at its tip', async () => {
    const deleted = [
      'diff --git a/test/old.test.mjs b/test/old.test.mjs',
      'deleted file mode 100644',
      '--- a/test/old.test.mjs',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      "-test('old', () => {});",
      '',
    ].join('\n');
    const { order, run } = setup({
      diff: { code: 0, stdout: `${gaugeDiff}${deleted}`, stderr: '' },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(
      order.filter((line) => line.startsWith('git cat-file')),
      [],
    );
  });

  it("is blocked on the environment when git cannot read the proven step's commits", async () => {
    const { order, run } = setup({
      diff: { code: 128, stdout: '', stderr: 'fatal: bad revision\n' },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the commits of step gauge cannot be read: fatal: bad revision',
    });
    assert.equal(order.length, 1);
  });
});

describe('createCheckRunner: the red proof and the test map (ADR 0274)', () => {
  it('proves red as before in a repository with no test map and a testReport: regression test', async () => {
    const { order, run } = setup({ maps: {} });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(
      order.filter((line) => !line.startsWith('git')),
      [`exec npm test in ${redTree}`],
    );
  });

  it('sticks a red proof on its environment for a new module no confirmed line reaches', async () => {
    const module = {
      code: ['src/**'],
      tests: { paths: ['test/**'] },
      coverage: 'none' as const,
    };
    const web = { ...module, name: 'web', testReport: { format: 'tap' as const, path: 'web.tap' } };
    const cli = { ...module, name: 'cli', testReport: { format: 'tap' as const, path: 'cli.tap' } };
    const derivedFrom = { globs: ['**/package.json'], paths: ['package.json'] };
    const maps: Record<string, MapRead> = {
      [gaugeStart]: { kind: 'map', map: { derivedFrom, modules: [web] } },
      ['b'.repeat(40)]: { kind: 'map', map: { derivedFrom, modules: [web, cli] } },
    };
    // The base's module wrote its report, and the new module none.
    const webReport = join(redTree, 'web.tap');
    const wrote = {
      maps,
      found: { 'web.tap': [webReport] },
      files: { [webReport]: { kind: 'text' as const, text: stubFails } },
    };
    const { run } = setup({ ...wrote, test: { exitCode: 0, stdout: '' } });
    const end = await run();
    assert.equal(end.ending.kind, 'blocked');
    assert.match(
      end.ending.kind === 'blocked' ? end.ending.summary : '',
      /^module "cli" of the test map is new in this batch/,
    );
    // A failing run keeps the red proof's own verdict (ADR 0280).
    const failing = setup(wrote);
    assert.deepEqual((await failing.run()).ending, { kind: 'succeeded', output: null });
  });
});

describe('createCheckRunner: the red proof reads every module of the test map (ADR 0274)', () => {
  const derivedFrom = { globs: ['**/package.json'], paths: ['package.json'] };
  const web: TestMapModule = {
    name: 'web',
    code: ['src/**'],
    tests: { paths: ['test/**'] },
    testReport: { format: 'tap', path: 'web/out/*.tap' },
    coverage: { format: 'lcov', path: 'web/lcov.info' },
  };
  const api: TestMapModule = {
    name: 'api',
    code: ['api/src/**'],
    tests: { paths: ['api/test/**'] },
    testReport: { format: 'junit', path: 'api/results.xml' },
    coverage: 'none',
  };
  const mapOf = (...modules: TestMapModule[]): MapRead => ({
    kind: 'map',
    map: { derivedFrom, modules },
  });
  const tip = 'b'.repeat(40);
  const webTaps = [join(redTree, 'web', 'out', 'a.tap'), join(redTree, 'web', 'out', 'b.tap')];
  const webLcov = join(redTree, 'web', 'lcov.info');
  const apiXml = join(redTree, 'api', 'results.xml');
  const text = (value: string) => ({ kind: 'text' as const, text: value });
  const passingXml = '<testsuites><testcase name="serves"/></testsuites>';
  // What both modules wrote: web's failing test in one of its two reports.
  const wrote = {
    found: { 'web/out/*.tap': webTaps, 'web/lcov.info': [webLcov], 'api/results.xml': [apiXml] },
    files: {
      [webTaps[0] ?? '']: text(stubFails),
      [webTaps[1] ?? '']: text('ok 1 - other\n1..1'),
      [apiXml]: text(passingXml),
    } as Record<string, OutDocRead>,
  };

  it("clears every report path the map names before the run, and reads each module's report after it", async () => {
    const { order, run, execOptions } = setup({
      ...wrote,
      maps: { [gaugeStart]: mapOf(web, api), [tip]: mapOf(web, api) },
      // No testReport in foedrum.jsonc, and nothing on stdout: the map says where the reports are.
      report: null,
      test: { exitCode: 1, stdout: 'not TAP' },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(execOptions[0]?.maxOutputBytes, undefined);
    assert.deepEqual(
      order.filter((line) => !line.startsWith('git')),
      [
        `find web/out/*.tap in ${redTree}`,
        `clear ${webTaps[0]}`,
        `clear ${webTaps[1]}`,
        `find web/lcov.info in ${redTree}`,
        `clear ${webLcov}`,
        `find api/results.xml in ${redTree}`,
        `clear ${apiXml}`,
        `exec npm test in ${redTree}`,
        `find web/out/*.tap in ${redTree}`,
        `read ${webTaps[0]} inside ${redTree}`,
        `read ${webTaps[1]} inside ${redTree}`,
        `find web/lcov.info in ${redTree}`,
        `find api/results.xml in ${redTree}`,
        `read ${apiXml} inside ${redTree}`,
      ],
    );
    // Nothing deleted, so the base's files are not listed.
    assert.deepEqual(
      order.filter((line) => line.startsWith('git ls-tree')),
      [],
    );
  });

  it("counts a module the base's map lists that wrote no report as a load error", async () => {
    const { run } = setup({ maps: { [gaugeStart]: mapOf(web), [tip]: mapOf(web) } });
    assert.deepEqual(
      (await run()).ending,
      failedWith(
        'the red proof of step gauge failed: the run has a load, compile, import or collection error: module "web" wrote no test report at web/out/*.tap',
      ),
    );
  });

  it("counts a module the base's map lists that wrote no coverage report as a load error, unless it has no coverage tool", async () => {
    const found = { 'web/out/*.tap': webTaps, 'api/results.xml': [apiXml] };
    const { run } = setup({
      ...wrote,
      found,
      maps: { [gaugeStart]: mapOf(web), [tip]: mapOf(web) },
    });
    assert.deepEqual(
      (await run()).ending,
      failedWith(
        'the red proof of step gauge failed: the run has a load, compile, import or collection error: module "web" wrote no coverage report at web/lcov.info',
      ),
    );
    const none = setup({
      ...wrote,
      found,
      maps: { [gaugeStart]: mapOf({ ...web, coverage: 'none' }), [tip]: mapOf(web) },
    });
    assert.deepEqual((await none.run()).ending, { kind: 'succeeded', output: null });
  });

  it('leaves a module only the batch lists that wrote no report to the unreached rule: regression test', async () => {
    const found = { 'web/out/*.tap': webTaps, 'web/lcov.info': [webLcov] };
    const { run } = setup({
      ...wrote,
      found,
      maps: { [gaugeStart]: mapOf(web), [tip]: mapOf(web, api) },
    });
    assert.deepEqual((await run()).ending, { kind: 'succeeded', output: null });
  });

  it('reads the map the batch added when the base has none, and lists no deleted files', async () => {
    const { order, run } = setup({ ...wrote, maps: { [tip]: mapOf(web) } });
    assert.deepEqual((await run()).ending, { kind: 'succeeded', output: null });
    assert.ok(order.includes(`read ${webTaps[0]} inside ${redTree}`), order.join('\n'));
    assert.deepEqual(
      order.filter((line) => line.includes('--diff-filter=D')),
      [],
    );
  });

  it('drops a base module whose every file the batch deleted, and keeps one it left a file of', async () => {
    const old: TestMapModule = {
      ...api,
      name: 'old',
      code: ['old/src/**'],
      tests: { paths: ['old/test/**'] },
      testReport: { format: 'tap', path: 'old.tap' },
    };
    const maps = { [gaugeStart]: mapOf(web, old), [tip]: mapOf(web) };
    const gone = ['old/src/a.ts', 'old/test/a.test.ts'];
    const listed = (paths: string[]) => paths.map((path) => `${path}\u0000`).join('');
    const { order, run } = setup({
      ...wrote,
      maps,
      deleted: listed(gone),
      atBase: listed([...gone, 'src/x.ts']),
    });
    assert.deepEqual((await run()).ending, { kind: 'succeeded', output: null });
    assert.deepEqual(
      order.filter((line) => line.startsWith('git ') && !line.includes(' --unified=0 ')),
      [
        `git diff --name-only -z --no-renames --diff-filter=D ${gaugeStart} ${tip} in ${clone}`,
        `git ls-tree -r -z --name-only ${gaugeStart} in ${clone}`,
      ],
    );
    const kept = setup({
      ...wrote,
      maps,
      deleted: listed(gone),
      atBase: listed([...gone, 'old/src/b.ts']),
    });
    assert.deepEqual(
      (await kept.run()).ending,
      failedWith(
        'the red proof of step gauge failed: the run has a load, compile, import or collection error: module "old" wrote no test report at old.tap',
      ),
    );
  });

  it('sticks a red proof on its environment before the run when a module writes a TRX report', async () => {
    const billing: TestMapModule = {
      ...api,
      name: 'billing',
      testReport: { format: 'trx', path: 'svc/test/*/TestResults' },
    };
    const { order, run } = setup({
      maps: { [gaugeStart]: mapOf(web), [tip]: mapOf(web, billing) },
    });
    assert.deepEqual((await run()).ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'module "billing" of the test map writes a TRX test report, which Foedrum does not read yet: make its tests write JUnit XML (such as with JunitXml.TestLogger) and name that in the test map (ADR 0274)',
    });
    assert.ok(!order.some((line) => line.startsWith('exec')), order.join('\n'));
  });

  it('is blocked on the environment, running nothing, when a report path is refused or cannot be cleared', async () => {
    const maps = { [gaugeStart]: mapOf(web), [tip]: mapOf(web) };
    const refused = setup({
      ...wrote,
      maps,
      refusedPatterns: { 'web/lcov.info': 'web/lcov.info leads out of the worktree' },
    });
    assert.deepEqual((await refused.run()).ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the reports of the test map cannot be cleared: web/lcov.info leads out of the worktree',
    });
    assert.ok(!refused.order.some((line) => line.startsWith('exec')), refused.order.join('\n'));
    const held = setup({ ...wrote, maps, clearFails: 'it is held open' });
    assert.deepEqual((await held.run()).ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the reports of the test map cannot be cleared: web/out/*.tap cannot be cleared: it is held open',
    });
    assert.ok(!held.order.some((line) => line.startsWith('exec')), held.order.join('\n'));
  });

  it("fails when a module's report cannot be read or is not in its format", async () => {
    const maps = { [gaugeStart]: mapOf(web), [tip]: mapOf(web) };
    const unread = setup({
      ...wrote,
      maps,
      files: { ...wrote.files, [webTaps[1] ?? '']: { kind: 'unread', reason: 'it is a link' } },
    });
    assert.deepEqual(
      (await unread.run()).ending,
      failedWith(
        'the red proof of step gauge failed: the test report web/out/b.tap of module "web" cannot be read: it is a link',
      ),
    );
    const garbled = setup({
      ...wrote,
      maps,
      files: { ...wrote.files, [webTaps[1] ?? '']: text('not TAP') },
    });
    assert.deepEqual(
      (await garbled.run()).ending,
      failedWith(
        'the red proof of step gauge failed: the test report web/out/b.tap of module "web" is not TAP: it has no TAP test point',
      ),
    );
  });

  it("sticks a red proof whose base's map cannot be read, and fails one whose own map cannot be", async () => {
    const bad = { kind: 'unreadable' as const, reason: 'it is not JSONC' };
    const base = setup({ ...wrote, maps: { [gaugeStart]: bad, [tip]: mapOf(web) } });
    assert.deepEqual((await base.run()).ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the test map of acme/api at ${gaugeStart} cannot be read: it is not JSONC`,
    });
    const own = setup({ ...wrote, maps: { [gaugeStart]: mapOf(web), [tip]: bad } });
    assert.deepEqual((await own.run()).ending, {
      kind: 'failed',
      retryable: false,
      reason: `the test map of acme/api at ${tip} cannot be read: it is not JSONC`,
    });
    assert.ok(!own.order.some((line) => line.startsWith('exec')), own.order.join('\n'));
  });

  it('settles a mapped test check that did not exit as any check does, reading no report: regression test', async () => {
    const { order, run } = setup({
      ...wrote,
      maps: { [gaugeStart]: mapOf(web), [tip]: mapOf(web) },
      test: { exitCode: null, killed: 'timed-out', stdout: '' },
    });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
    assert.deepEqual(
      end.readings?.map((reading) => reading.result),
      ['killed'],
    );
    assert.ok(order.includes(`exec npm test in ${redTree}`), order.join('\n'));
    assert.ok(!order.some((line) => line.startsWith('read ')), order.join('\n'));
  });

  it('reads the map and the deleted files at the base the batch merged (ADR 0164): regression test', async () => {
    const merged = 'e'.repeat(40);
    const key = effectKey.encode(baseMergeKey({ batchId: '12-1', stepId: 'gauge', attempt: 1 }));
    const merge: Event = {
      type: 'effect.applied',
      key,
      result: { base: merged, merged: 'f'.repeat(40) },
    };
    // Only the merged base's map lists web: the start's map would leave it unread.
    const { order, run } = setup({
      ...wrote,
      events: [...ordered, ...gauged, merge, ...redStarted],
      maps: { [gaugeStart]: mapOf(api), [merged]: mapOf(web), [tip]: mapOf(web) },
    });
    assert.deepEqual((await run()).ending, { kind: 'succeeded', output: null });
    assert.ok(
      order.includes(
        `git diff --name-only -z --no-renames --diff-filter=D ${merged} ${tip} in ${clone}`,
      ),
      order.join('\n'),
    );
  });

  it('is blocked on the environment when git cannot list the deleted files or the files at the base: regression test', async () => {
    const maps = { [gaugeStart]: mapOf(web), [tip]: mapOf(web) };
    const failed = (stderr: string): GitResult => ({ code: 128, stdout: '', stderr });
    const cases: [Partial<Parameters<typeof setup>[0]>, string][] = [
      [
        { deleted: failed('warning: x\nfatal: bad object\n') },
        `the files deleted since ${gaugeStart} cannot be read: fatal: bad object`,
      ],
      [
        { deleted: 'old/a.ts\u0000', atBase: failed('fatal: not a tree\n') },
        `the files at ${gaugeStart} cannot be read: fatal: not a tree`,
      ],
      [
        { deleted: failed('') },
        `the files deleted since ${gaugeStart} cannot be read: git exited with 128`,
      ],
    ];
    for (const [more, summary] of cases) {
      const { order, run } = setup({ ...wrote, maps, ...more });
      assert.deepEqual((await run()).ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary,
      });
      assert.ok(!order.some((line) => line.startsWith('exec')), order.join('\n'));
    }
  });

  it("places a test the run writes under the worktree's real path, which the runner asks the file system for", async () => {
    const real = join('/private', redTree);
    const located = [
      'TAP version 13',
      'not ok 1 - adds two numbers',
      '  ---',
      `  location: '${join(real, 'test', 'add.test.mjs').replaceAll('\\', '\\\\')}:1:1'`,
      '  ...',
      '1..1',
    ].join('\n');
    const maps = { [gaugeStart]: mapOf(web), [tip]: mapOf(web) };
    const files = { ...wrote.files, [webTaps[0] ?? '']: text(located) };
    const linked = setup({
      ...wrote,
      files,
      maps,
      realPathOf: (path) => (path === redTree ? real : path),
    });
    assert.deepEqual((await linked.run()).ending, { kind: 'succeeded', output: null });
    // Without the link the place is outside the worktree.
    const unlinked = setup({ ...wrote, files, maps });
    const ending = (await unlinked.run()).ending;
    assert.match(
      ending.kind === 'failed' ? ending.reason : '',
      /no failing test lies in a test file the step changed/,
    );
  });

  it("folds a report path's case against git's on the platforms whose file system folds it: regression test", async () => {
    const located = [
      'TAP version 13',
      'not ok 1 - adds two numbers',
      '  ---',
      `  location: '${join(redTree, 'Test', 'Add.test.mjs').replaceAll('\\', '\\\\')}:1:1'`,
      '  ...',
      '1..1',
    ].join('\n');
    const maps = { [gaugeStart]: mapOf(web), [tip]: mapOf(web) };
    const files = { ...wrote.files, [webTaps[0] ?? '']: text(located) };
    const folded = setup({ ...wrote, files, maps, platform: 'darwin' });
    assert.deepEqual((await folded.run()).ending, { kind: 'succeeded', output: null });
    const ending = (await setup({ ...wrote, files, maps }).run()).ending;
    assert.match(
      ending.kind === 'failed' ? ending.reason : '',
      /no failing test lies in a test file the step changed/,
    );
  });

  it("places the step's changed files in the map's areas: a step outside them is refused", async () => {
    const elsewhere: TestMapModule = { ...web, tests: { paths: ['spec/**'] } };
    const { run } = setup({
      ...wrote,
      maps: { [gaugeStart]: mapOf(elsewhere), [tip]: mapOf(elsewhere) },
    });
    assert.deepEqual(
      (await run()).ending,
      failedWith(
        'the red proof of step gauge failed: the step changed no file in a test area of the test map, nor in a module whose tests are inline',
      ),
    );
  });
});
