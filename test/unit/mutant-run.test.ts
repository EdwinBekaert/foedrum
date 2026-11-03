// Brett's mutants run around the brewer runner (ADR 0040, ADR 0313): once a Brett attempt
// succeeded, the engine checks its mutants against the change, runs the tests once in a scratch
// tree as the baseline and once per valid mutant in a fresh one, and records each verdict on the
// attempt's end. A fake git, fake scratch trees and a fake test run; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestRun, TestRunEnd } from '../../src/checks/check-runner.ts';
import { mutated } from '../../src/checks/mutant-run.ts';
import { mutantCheck } from '../../src/checks/mutants.ts';
import type { MappedReport } from '../../src/checks/red-proof.ts';
import type { MapRead } from '../../src/checks/test-map.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { TestResult } from '../../src/formats/test-report.ts';
import { Event, MAX_MUTANT_TEXT } from '../../src/schemas/events.ts';
import { type MutantEdit, MutantsOutDoc } from '../../src/schemas/out-doc.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';
import type { CommitTree } from '../../src/workspace/merge-tree-git.ts';

const t0 = new Date('2026-11-03T12:00:00.000Z');
const deadlineAt = '2026-11-03T12:20:00.000Z';
const root = join('/work', 'acme.api', 'attempts', '12-1');
const clone = join('/work', 'acme.api', 'clone.git');
const base = 'a'.repeat(40);
const head = 'c'.repeat(40);
const ref: AttemptRef = { batchId: '12-1', stepId: 'brett', attempt: 1 };

const worktree = (stepId: string, commit: string) => ({
  repo: 'acme/api',
  path: join(root, stepId, '1'),
  branch: `foedrum/12-1/${stepId}/1`,
  commit,
});

/** The batch: its implement step started at `base` and succeeded, then Brett started at `head`. */
const eventsOf = (brettDeadline = deadlineAt): Event[] => [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'taste', reason: 'l', source: 'label' },
  { type: 'step.scheduled', batchId: '12-1', stepId: 'implement', attempt: 1, deadlineAt },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    worktree: worktree('implement', base),
  },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    outcome: { kind: 'succeeded', output: null },
  },
  { type: 'step.scheduled', ...ref, deadlineAt: brettDeadline },
  { type: 'step.started', ...ref, worktree: worktree('brett', head) },
];

/** The code the change added, at `head`. */
const code = [
  'export const add = (a, b) => a + b;',
  'export const clamp = (n) => (n > 10 ? 10 : n);',
  '',
].join('\n');

const diff = [
  'diff --git a/src/add.mjs b/src/add.mjs',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/add.mjs',
  '@@ -0,0 +1,2 @@',
  '+export const add = (a, b) => a + b;',
  '+export const clamp = (n) => (n > 10 ? 10 : n);',
  '',
].join('\n');

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });

/** The clone: the change from `base` to `head`, and the file at `head`. */
const git: Git = async (cwd, args) => {
  assert.equal(cwd, clone);
  if (args.includes('diff') && args.includes(base) && args.includes(head)) return ok(diff);
  if (args.includes('cat-file') && args.includes(`${head}:src/add.mjs`)) return ok(code);
  return { code: 128, stdout: '', stderr: `fatal: unexpected git ${args.join(' ')}` };
};

const map: MapRead = {
  kind: 'map',
  map: {
    derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
    modules: [
      {
        name: 'api',
        code: ['src/**'],
        tests: { paths: ['test/**'] },
        testReport: { format: 'tap', path: 'report.tap' },
        coverage: 'none',
      },
    ],
  },
};

const mutant = (
  original: string,
  replacement: string,
  line: number,
  description: string,
): MutantEdit => ({ file: 'src/add.mjs', line, original, replacement, description });

const subtracts = mutant(
  'export const add = (a, b) => a + b;',
  'export const add = (a, b) => a - b;',
  1,
  'add subtracts',
);
const boundary = mutant(
  'export const clamp = (n) => (n > 10 ? 10 : n);',
  'export const clamp = (n) => (n >= 10 ? 10 : n);',
  2,
  'clamp at ten',
);
const adds = mutant(
  'export const add = (a, b) => a + b;',
  'export const add = (a, b) => a + b + c;',
  1,
  'add a third',
);
const loops = mutant(
  'export const clamp = (n) => (n > 10 ? 10 : n);',
  'export const clamp = (n) => (n > 10 ? 10 : n);;',
  2,
  'clamp loops',
);

/** A Brett attempt that ends with `end`, or done with `mutants`. */
const brett = (mutants: readonly MutantEdit[], end?: AttemptEnd): BrewerRunner => ({
  start: () => ({
    ended: Promise.resolve(
      end ?? {
        ending: {
          kind: 'succeeded',
          output: {
            status: 'done',
            summary: 'Mutants',
            mutants: mutants.map((each) => ({ ...each })),
          },
        },
      },
    ),
    stop: () => {},
  }),
  progress: () => undefined,
});

type Outcomes = Readonly<Record<string, TestResult>>;

/** A mutant tree's file as its edit rewrote the commit's text. */
interface Edited {
  file: string;
  content: string;
}

/** A report of module api with these tests, in this order. */
const report = (outcomes: Outcomes): MappedReport => ({
  module: 'api',
  other: '',
  tests: Object.entries(outcomes).map(([name, result]) => ({
    name,
    result,
    leaf: true,
    detail: '',
  })),
});

const exited = (exitCode: number) =>
  ({ result: 'exited', check: 'test', command: 'npm test', exitCode, tail: '' }) as const;

/** What a run reads: its tests, as they came out. */
const ran = (outcomes: Outcomes): TestRunEnd => ({
  kind: 'ran',
  reading: exited(Object.values(outcomes).includes('failed') ? 1 : 0),
  reports: [report(outcomes)],
});

const baseline: Outcomes = {
  'adds two numbers': 'passed',
  'adds negatives': 'passed',
  'clamps big numbers': 'passed',
};

/**
 * The wrapper over `runner`, with scratch trees that record what they were opened with and when
 * they went, and a test run that answers by the tree's edit: `runs` gives each edit's outcome.
 */
const setup = ({
  runner,
  mutates = true,
  events = eventsOf(),
  runs = () => ran(baseline),
  clock = () => t0,
  checkedOut = code,
  clonedGit = git,
  mapAt = map,
  blocking = false,
}: {
  runner: BrewerRunner;
  mutates?: boolean;
  events?: Event[];
  runs?: (edit: Edited | undefined, deadlineAt: string) => TestRunEnd | Promise<TestRunEnd>;
  clock?: () => Date;
  /** The mutant's file as git checks it out in a scratch tree. */
  checkedOut?: string;
  /** git in the clone, where the change and the mutant's file are read. */
  clonedGit?: Git;
  /** The test map at every commit. */
  mapAt?: MapRead;
  /** Whether the step blocks on a survivor (ADR 0319). */
  blocking?: boolean;
}) => {
  const opened: { commit: string; edit?: Edited; path: string }[] = [];
  const removed: string[] = [];
  const edits = new Map<string, Edited | undefined>();
  const tree: CommitTree = async (commit, use, options = {}) => {
    const path = join('/scratch', String(opened.length + 1));
    const edit =
      options.edit === undefined
        ? undefined
        : { file: options.edit.file, content: options.edit.rewrite(checkedOut) };
    opened.push({ commit, path, ...(edit === undefined ? {} : { edit }) });
    edits.set(path, edit);
    try {
      return await use(path);
    } finally {
      removed.push(path);
    }
  };
  const runDeadlines: string[] = [];
  const testRun: TestRun = async (at, modules, runDeadline) => {
    assert.equal(at.repo, 'acme/api');
    assert.deepStrictEqual(
      modules.map(({ module }) => module.name),
      ['api'],
    );
    runDeadlines.push(runDeadline);
    return runs(edits.get(at.path), runDeadline);
  };
  const state = fold(events);
  const wrapped = mutated({
    runner,
    state: () => state,
    mutates: () => mutates,
    git: clonedGit,
    clone: () => clone,
    testMap: async () => mapAt,
    tree: () => tree,
    testRun,
    platform: 'linux',
    clock,
  });
  const limits = { outDoc: { file: 'mutants.md', schema: MutantsOutDoc }, blocking };
  const start = () => wrapped.start({ ref, limits });
  const end = () => start().ended;
  return { end, start, wrapped, opened, removed, runDeadlines };
};

/** Each run's outcome by the mutant its tree holds. */
const byEdit =
  (outcomes: ReadonlyMap<string, Outcomes>) =>
  (edit: Edited | undefined): TestRunEnd => {
    if (edit === undefined) return ran(baseline);
    const found = [...outcomes].find(([replacement]) => edit.content.includes(replacement));
    return ran(found === undefined ? baseline : found[1]);
  };

describe('mutated', () => {
  it('a brewer that writes no mutants out doc runs as today (regression test)', async () => {
    const end: AttemptEnd = {
      ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
    };
    const { end: ended, opened } = setup({ runner: brett([], end), mutates: false });
    assert.deepStrictEqual(await ended(), end);
    assert.deepStrictEqual(opened, []);
  });

  it('a Brett attempt that failed or asked runs no mutant (regression test)', async () => {
    const endings: AttemptEnd['ending'][] = [
      { kind: 'failed', retryable: true, reason: 'the session ended early' },
      {
        kind: 'needs_input',
        questions: [
          { q: 'Which file?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'Two changes' },
        ],
      },
    ];
    for (const ending of endings) {
      const end: AttemptEnd = { ending };
      const { end: ended, opened } = setup({ runner: brett([subtracts], end) });
      assert.deepStrictEqual(await ended(), end);
      assert.deepStrictEqual(opened, []);
    }
  });

  it('a store without mutants folds as today (regression test)', () => {
    const state = fold([
      ...eventsOf(),
      { type: 'step.finished', ...ref, outcome: { kind: 'succeeded', output: null } },
    ]);
    const attempt = state.batches.get('12-1')?.steps.get('brett')?.attempts.get(1);
    assert.equal(attempt?.phase, 'finished');
    assert.equal(attempt !== undefined && 'mutants' in attempt, false);
  });
});

describe('mutated, judging mutants', () => {
  it('a mutant the tests catch is killed by the first test that fails against it', async () => {
    const runs = byEdit(
      new Map([
        [
          'a - b',
          {
            'adds two numbers': 'failed',
            'adds negatives': 'failed',
            'clamps big numbers': 'passed',
          },
        ],
      ]),
    );
    const { end } = setup({ runner: brett([subtracts]), runs });
    const ended = await end();
    assert.equal(ended.ending.kind, 'succeeded');
    assert.deepStrictEqual(ended.mutants, [
      {
        file: 'src/add.mjs',
        line: 1,
        description: 'add subtracts',
        verdict: { kind: 'killed', by: 'adds two numbers' },
      },
    ]);
  });

  it('a mutant no test catches survives', async () => {
    const { end, opened } = setup({ runner: brett([boundary]) });
    const ended = await end();
    assert.equal(ended.ending.kind, 'succeeded');
    assert.deepStrictEqual(ended.mutants, [
      {
        file: 'src/add.mjs',
        line: 2,
        description: 'clamp at ten',
        original: 'export const clamp = (n) => (n > 10 ? 10 : n);',
        replacement: 'export const clamp = (n) => (n >= 10 ? 10 : n);',
        verdict: { kind: 'survived' },
      },
    ]);
    // The mutant's tree holds the file as the mutant left it.
    const [, mutantTree] = opened;
    assert.equal(mutantTree?.edit?.file, 'src/add.mjs');
    assert.equal(
      mutantTree?.edit?.content,
      code.replace('(n > 10 ? 10 : n)', '(n >= 10 ? 10 : n)'),
    );
  });

  it('an invalid mutant is recorded with its reason and never run', async () => {
    const change = {
      inCode: () => true,
      changed: () => ({ content: code, added: new Set([1, 2]) }),
    };
    const reason = mutantCheck(adds, change);
    assert.equal(reason.ok, false);
    const { end, opened } = setup({ runner: brett([adds]) });
    const ended = await end();
    assert.equal(ended.ending.kind, 'succeeded');
    assert.deepStrictEqual(ended.mutants, [
      {
        file: 'src/add.mjs',
        line: 1,
        description: 'add a third',
        verdict: { kind: 'invalid', reason: reason.ok ? '' : reason.reason },
      },
    ]);
    // No valid mutant: not even the baseline runs.
    assert.deepStrictEqual(opened, []);
  });

  it('a mutant is judged against a fresh baseline, so a test that already failed kills nothing', async () => {
    const broken = { ...baseline, 'clamps big numbers': 'failed' } as const;
    // The baseline fails one test; the mutant fails the same one, and no other.
    const runs = () => ran(broken);
    const { end, opened, removed } = setup({ runner: brett([boundary, subtracts]), runs });
    const ended = await end();
    assert.deepStrictEqual(
      ended.mutants?.map(({ verdict }) => verdict),
      [{ kind: 'survived' }, { kind: 'survived' }],
    );
    // The baseline in a tree of its own at the attempt's commit, then a fresh tree per mutant,
    // each gone before the next opens.
    assert.deepStrictEqual(
      opened.map(({ commit, edit }) => [commit, edit?.content.includes('>=') ?? 'none']),
      [
        [head, 'none'],
        [head, true],
        [head, false],
      ],
    );
    assert.equal(new Set(opened.map(({ path }) => path)).size, 3);
    assert.deepStrictEqual(
      removed,
      opened.map(({ path }) => path),
    );
  });

  it('the scratch trees are removed when the runs end, also when one fails', async () => {
    const runs = (edit: Edited | undefined) => {
      if (edit?.content.includes('a - b')) throw new Error('the tree is gone');
      return ran(baseline);
    };
    const { end, opened, removed } = setup({ runner: brett([subtracts, boundary]), runs });
    const ended = await end();
    assert.equal(ended.ending.kind, 'succeeded');
    assert.deepStrictEqual(
      ended.mutants?.map(({ verdict }) => verdict),
      [{ kind: 'notJudged', why: 'its test run failed: the tree is gone' }, { kind: 'survived' }],
    );
    assert.equal(opened.length, 3);
    assert.deepStrictEqual(
      removed,
      opened.map(({ path }) => path),
    );
  });

  it('a mutant whose run passes three times the baseline time times out, which kills it', async () => {
    let now = t0.getTime();
    const runs = (edit: Edited | undefined, runDeadline: string): TestRunEnd => {
      // The baseline takes a minute; the looping mutant runs until its deadline.
      if (edit === undefined) {
        now += 60_000;
        return ran(baseline);
      }
      now = Date.parse(runDeadline);
      return {
        kind: 'ran',
        reading: {
          result: 'killed',
          check: 'test',
          command: 'npm test',
          killed: 'timed-out',
          tail: '',
        },
        reports: [],
      };
    };
    const { end, runDeadlines } = setup({
      runner: brett([loops]),
      runs,
      clock: () => new Date(now),
    });
    const ended = await end();
    assert.deepStrictEqual(
      ended.mutants?.map(({ verdict }) => verdict),
      [{ kind: 'timedOut' }],
    );
    // The baseline until a minute before the step's deadline; the mutant three baselines long.
    assert.deepStrictEqual(runDeadlines, [
      '2026-11-03T12:19:00.000Z',
      new Date(t0.getTime() + 60_000 + 180_000).toISOString(),
    ]);
  });

  it("mutants left when the step's deadline nears are not judged, and the attempt still succeeds", async () => {
    let now = t0.getTime();
    // The baseline takes until three minutes before the step's deadline.
    const runs = (edit: Edited | undefined, runDeadline: string): TestRunEnd => {
      now = edit === undefined ? Date.parse(deadlineAt) - 3 * 60_000 : Date.parse(runDeadline);
      return edit === undefined
        ? ran(baseline)
        : {
            kind: 'ran',
            reading: {
              result: 'killed',
              check: 'test',
              command: 'npm test',
              killed: 'timed-out',
              tail: '',
            },
            reports: [],
          };
    };
    const { end, opened } = setup({
      runner: brett([subtracts, boundary]),
      runs,
      clock: () => new Date(now),
    });
    const ended = await end();
    assert.equal(ended.ending.kind, 'succeeded');
    // The first mutant runs until a minute before the deadline and is cut off there; the second
    // has no time left to run.
    assert.deepStrictEqual(
      ended.mutants?.map(({ verdict }) => verdict),
      [
        { kind: 'notJudged', why: "the step's deadline came before its run ended" },
        { kind: 'notJudged', why: "the step's deadline came before it could run" },
      ],
    );
    assert.equal(opened.length, 2);
  });

  it('a mutant whose module passed no test at the baseline is not judged', async () => {
    const runs = () => ran({ 'adds two numbers': 'failed' });
    const { end } = setup({ runner: brett([subtracts]), runs });
    const ended = await end();
    assert.deepStrictEqual(
      ended.mutants?.map(({ verdict }) => verdict),
      [{ kind: 'notJudged', why: 'no test of module "api" passed at the baseline' }],
    );
  });

  it('a mutant tree keeps the line endings git checked out', async () => {
    // As Git for Windows checks a text file out with core.autocrlf.
    const crlf = code.replace(/\n/g, '\r\n');
    const { end, opened } = setup({ runner: brett([boundary]), checkedOut: crlf });
    await end();
    assert.equal(opened[1]?.edit?.content, crlf.replace('(n > 10 ? 10 : n)', '(n >= 10 ? 10 : n)'));
  });

  it('a mutant that breaks the build is not judged, and its reason says so', async () => {
    // The module wrote no report and its test check failed: a compile error (ADR 0313).
    const runs = (edit: Edited | undefined): TestRunEnd =>
      edit === undefined ? ran(baseline) : { kind: 'ran', reading: exited(1), reports: [] };
    const { end } = setup({ runner: brett([subtracts]), runs });
    const ended = await end();
    assert.deepStrictEqual(
      ended.mutants?.map(({ verdict }) => verdict),
      [
        {
          kind: 'notJudged',
          why: 'the mutant broke the build: module "api" wrote no test report and its test check failed',
        },
      ],
    );
  });
});

describe('mutated, its edges', () => {
  const verdicts = async (options: Parameters<typeof setup>[0]) =>
    (await setup(options).end()).mutants?.map(({ verdict }) => verdict);
  const signaled = {
    kind: 'ran',
    reading: {
      result: 'signaled',
      check: 'test',
      command: 'npm test',
      signal: 'SIGSEGV',
      tail: '',
    },
    reports: [],
  } as const;

  it('reports progress while its mutants run, and none once the attempt ended (regression test)', async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let entered = () => {};
    const running = new Promise<void>((done) => {
      entered = done;
    });
    const runs = async () => {
      entered();
      await gate;
      return ran(baseline);
    };
    const { start, wrapped } = setup({ runner: brett([boundary]), runs });
    const attempt = start();
    await running;
    assert.deepStrictEqual(wrapped.progress(ref), { lastProgressAt: t0, turnsWithoutProgress: 0 });
    release();
    await attempt.ended;
    assert.equal(wrapped.progress(ref), undefined);
  });

  it('a stop while the mutants run ends the attempt cancelled (regression test)', async () => {
    let entered = () => {};
    const running = new Promise<void>((done) => {
      entered = done;
    });
    // The run ends once the stop reaches it, as the process runner kills a run's tree.
    const runs = async (): Promise<TestRunEnd> => {
      entered();
      await new Promise((done) => setTimeout(done, 0));
      return ran(baseline);
    };
    const { start } = setup({ runner: brett([boundary]), runs });
    const attempt = start();
    await running;
    attempt.stop();
    assert.deepStrictEqual((await attempt.ended).ending, { kind: 'cancelled' });
  });

  it('a change or a file that cannot be read, or no test map, leaves every mutant not judged (regression test)', async () => {
    const failing =
      (word: string): Git =>
      async (cwd, args, options) =>
        args.includes(word)
          ? { code: 128, stdout: '', stderr: `fatal: no ${word}\n` }
          : git(cwd, args, options);
    assert.deepStrictEqual(
      await verdicts({ runner: brett([boundary]), clonedGit: failing('diff') }),
      [{ kind: 'notJudged', why: 'the change of the batch cannot be read: fatal: no diff' }],
    );
    assert.deepStrictEqual(
      await verdicts({ runner: brett([boundary]), clonedGit: failing('cat-file') }),
      [{ kind: 'notJudged', why: 'src/add.mjs cannot be read: fatal: no cat-file' }],
    );
    assert.deepStrictEqual(await verdicts({ runner: brett([boundary]), mapAt: { kind: 'none' } }), [
      { kind: 'notJudged', why: 'acme/api has no test map' },
    ]);
  });

  it('a baseline that did not run or did not exit, and a mutant run a signal ended, are not judged (regression test)', async () => {
    const unrun = () => ({ kind: 'unrun', why: 'npm ci failed' }) as const;
    assert.deepStrictEqual(await verdicts({ runner: brett([boundary]), runs: unrun }), [
      { kind: 'notJudged', why: 'the baseline did not run: npm ci failed' },
    ]);
    assert.deepStrictEqual(await verdicts({ runner: brett([boundary]), runs: () => signaled }), [
      { kind: 'notJudged', why: "the baseline's test check ended signaled" },
    ]);
    const mutantSignaled = (edit: Edited | undefined) =>
      edit === undefined ? ran(baseline) : signaled;
    assert.deepStrictEqual(await verdicts({ runner: brett([boundary]), runs: mutantSignaled }), [
      { kind: 'notJudged', why: 'its test check ended signaled' },
    ]);
  });

  it("a Brewery order's attempt with checkouts and no worktree runs no mutant (regression test)", async () => {
    const events = eventsOf().map((event) =>
      event.type === 'step.started' && event.stepId === 'brett'
        ? { type: 'step.started' as const, ...ref }
        : event,
    );
    const end: AttemptEnd = {
      ending: {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Mutants', mutants: [{ ...boundary }] },
      },
    };
    const { end: ended, opened } = setup({ runner: brett([boundary], end), events });
    assert.deepStrictEqual(await ended(), end);
    assert.deepStrictEqual(opened, []);
  });

  it('a mutant of a fast suite still gets a minute to run (regression test)', async () => {
    let now = t0.getTime();
    // The baseline takes ten seconds: three of them would be thirty.
    const runs = (edit: Edited | undefined): TestRunEnd => {
      if (edit === undefined) now += 10_000;
      return ran(baseline);
    };
    const { end, runDeadlines } = setup({
      runner: brett([boundary]),
      runs,
      clock: () => new Date(now),
    });
    await end();
    assert.equal(runDeadlines[1], new Date(t0.getTime() + 10_000 + 60_000).toISOString());
  });

  it('a test map that cannot be read is named by where it was read, never by a commit hash, which reads as a secret', async () => {
    assert.deepStrictEqual(
      await verdicts({
        runner: brett([boundary]),
        mapAt: { kind: 'unreadable', reason: 'bad JSON' },
      }),
      [
        {
          kind: 'notJudged',
          why: 'the test map of acme/api where the batch started cannot be read: bad JSON',
        },
      ],
    );
  });

  it('reports live progress through a long run, so the stall watchdog does not fire', async () => {
    let now = t0.getTime();
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let entered = () => {};
    const running = new Promise<void>((done) => {
      entered = done;
    });
    const runs = async () => {
      entered();
      await gate;
      return ran(baseline);
    };
    const { start, wrapped } = setup({
      runner: brett([boundary]),
      runs,
      clock: () => new Date(now),
    });
    const attempt = start();
    await running;
    // Eleven minutes into the baseline's run, past Brett's ten-minute stall.
    now += 11 * 60_000;
    assert.deepStrictEqual(wrapped.progress(ref)?.lastProgressAt, new Date(now));
    release();
    await attempt.ended;
  });
});

describe('mutated, round two', () => {
  it('reads the change from the base the batch merged, not its start (ADR 0164, regression test)', async () => {
    const moved = 'd'.repeat(40);
    const merged: Event = {
      type: 'effect.applied',
      key: effectKey.encode(baseMergeKey(ref)),
      result: { base: moved, merged: 'e'.repeat(40) },
    };
    // Only the merged base's diff is the change: one from the start would be refused.
    const fromMoved: Git = async (cwd, args, options) =>
      args.includes('diff') && !args.includes(moved)
        ? { code: 128, stdout: '', stderr: 'fatal: the start\n' }
        : git(
            cwd,
            args.map((arg) => (arg === moved ? base : arg)),
            options,
          );
    const { end } = setup({
      runner: brett([boundary]),
      events: [...eventsOf(), merged],
      clonedGit: fromMoved,
    });
    assert.deepStrictEqual(
      (await end()).mutants?.map(({ verdict }) => verdict),
      [{ kind: 'survived' }],
    );
  });

  it("cuts a mutant's description, leaves a secret out, and the event holds the record (regression test)", async () => {
    const long = { ...boundary, description: 'x'.repeat(600) };
    const secret = { ...subtracts, description: `ghp_${'A1b2'.repeat(9)}` };
    const ended = await setup({ runner: brett([long, secret]) }).end();
    const [first, second] = ended.mutants ?? [];
    assert.equal(first?.description.length, MAX_MUTANT_TEXT);
    assert.ok(first?.description.endsWith('…'));
    assert.equal(second?.description, '[left out: a name that looks like a secret]');
    const finished = Event.safeParse({
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'succeeded', output: null },
      mutants: ended.mutants,
    });
    assert.equal(finished.success, true, JSON.stringify(finished.error?.issues));
  });

  it('runs no mutant of a brewer that does not mutate, even when its output holds mutants (regression test)', async () => {
    const { end, opened } = setup({ runner: brett([boundary]), mutates: false });
    const ended = await end();
    assert.equal(ended.mutants, undefined);
    assert.deepStrictEqual(opened, []);
  });
});
