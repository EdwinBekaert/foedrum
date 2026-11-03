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
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { fold } from '../../src/engine/fold.ts';
import type { TestResult } from '../../src/formats/test-report.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { MutantEdit } from '../../src/schemas/out-doc.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';
import type { CommitTree, TreeEdit } from '../../src/workspace/merge-tree-git.ts';

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
  runs = (edit) => ran(edit === undefined ? baseline : baseline),
  clock = () => t0,
}: {
  runner: BrewerRunner;
  mutates?: boolean;
  events?: Event[];
  runs?: (edit: TreeEdit | undefined, deadlineAt: string) => TestRunEnd | Promise<TestRunEnd>;
  clock?: () => Date;
}) => {
  const opened: { commit: string; edit?: TreeEdit; path: string }[] = [];
  const removed: string[] = [];
  const edits = new Map<string, TreeEdit | undefined>();
  const tree: CommitTree = async (commit, use, options = {}) => {
    const path = join('/scratch', String(opened.length + 1));
    opened.push({ commit, path, ...(options.edit === undefined ? {} : { edit: options.edit }) });
    edits.set(path, options.edit);
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
    git,
    clone: () => clone,
    testMap: async () => map,
    tree: () => tree,
    testRun,
    platform: 'linux',
    clock,
  });
  const end = () => wrapped.start({ ref, prompt: 'Mutate' } as never).ended;
  return { end, opened, removed, runDeadlines };
};

/** Each run's outcome by the mutant its tree holds. */
const byEdit =
  (outcomes: ReadonlyMap<string, Outcomes>) =>
  (edit: TreeEdit | undefined): TestRunEnd => {
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
    const runs = (edit: TreeEdit | undefined) =>
      // The baseline fails one test; the mutant fails the same one, and no other.
      ran(edit === undefined ? broken : broken);
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
    const runs = (edit: TreeEdit | undefined) => {
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
    const runs = (edit: TreeEdit | undefined, runDeadline: string): TestRunEnd => {
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
    const runs = (edit: TreeEdit | undefined, runDeadline: string): TestRunEnd => {
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
    const runs = (edit: TreeEdit | undefined) =>
      ran(edit === undefined ? { 'adds two numbers': 'failed' } : { 'adds two numbers': 'failed' });
    const { end } = setup({ runner: brett([subtracts]), runs });
    const ended = await end();
    assert.deepStrictEqual(
      ended.mutants?.map(({ verdict }) => verdict),
      [{ kind: 'notJudged', why: 'no test of module "api" passed at the baseline' }],
    );
  });
});
