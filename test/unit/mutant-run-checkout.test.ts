// The text a baseline's coverage offsets are read against (#1176, ADR 0431): the file as the
// baseline's tree holds it, whose line endings may be the platform's (git for Windows checks out
// CRLF), not as the commit holds it. The other cases of the mutants' runs are in
// test/unit/mutant-run.test.ts, whose scratch trees are paths no folder holds.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TestRun, TestRunEnd, TestScope } from '../../src/checks/check-runner.ts';
import type { TestCoverage } from '../../src/checks/mutant-reach.ts';
import { mutated } from '../../src/checks/mutant-run.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import { type MutantEdit, MutantsOutDoc } from '../../src/schemas/out-doc.ts';
import type { Git } from '../../src/workspace/git.ts';
import type { CommitTree } from '../../src/workspace/merge-tree-git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-11-27T12:00:00.000Z');
const deadlineAt = '2026-11-27T12:20:00.000Z';
const clone = join('/work', 'acme.api', 'clone.git');
const base = 'a'.repeat(40);
const head = 'c'.repeat(40);
const ref: AttemptRef = { batchId: '12-1', stepId: 'brett', attempt: 1 };
const worktree = (stepId: string, commit: string) => ({
  repo: 'acme/api',
  path: join('/work', 'acme.api', 'attempts', '12-1', stepId, '1'),
  branch: `foedrum/12-1/${stepId}/1`,
  commit,
});
const events: Event[] = [
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
  { type: 'step.scheduled', ...ref, deadlineAt },
  { type: 'step.started', ...ref, worktree: worktree('brett', head) },
];

const lines = [
  'export const add = (a, b) => a + b;',
  'export const clamp = (n) => (n > 10 ? 10 : n);',
  'export const twice = (n) => n * 2;',
];
/** The file at the commit, with line feeds. */
const code = `${lines.join('\n')}\n`;
const diff = [
  'diff --git a/src/add.mjs b/src/add.mjs',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/add.mjs',
  '@@ -0,0 +1,3 @@',
  ...lines.map((line) => `+${line}`),
  '',
].join('\n');
const git: Git = async (_cwd, args) => {
  if (args.includes('diff')) return { code: 0, stdout: diff, stderr: '' };
  if (args.includes('cat-file')) return { code: 0, stdout: code, stderr: '' };
  return { code: 128, stdout: '', stderr: `fatal: unexpected git ${args.join(' ')}` };
};

/** The mutant of the second line. */
const clamps: MutantEdit = {
  file: 'src/add.mjs',
  line: 2,
  original: lines[1] ?? '',
  replacement: 'export const clamp = (n) => (n >= 10 ? 10 : n);',
  description: 'clamp at ten',
};

const exited = {
  result: 'exited',
  check: 'test',
  command: 'npm test',
  exitCode: 0,
  tail: '',
} as const;
const ranTests: TestRunEnd = {
  kind: 'ran',
  reading: exited,
  reports: [
    {
      module: 'api',
      other: '',
      tests: [
        {
          name: 'adds',
          result: 'passed',
          leaf: true,
          detail: '',
          location: { file: 'test/a.test.ts', line: 3 },
        },
      ],
    },
  ],
};

let dir: TempDir;
beforeEach(() => {
  dir = makeTempDir('mutant-run-checkout');
});
afterEach(() => dir.remove());

/**
 * Brett's one mutant, judged with a baseline whose tree holds the file as `onDisk`, and whose
 * test a.test.ts ran only the characters before offset `ranTo` of that text: the scopes of the runs
 * it asked for, and its verdict.
 */
const judged = async (onDisk: string, ranTo: number) => {
  const tree = join(dir.path, 'tree');
  mkdirSync(join(tree, 'src'), { recursive: true });
  writeFileSync(join(tree, 'src', 'add.mjs'), onDisk);
  const coverage: TestCoverage = new Map([
    [
      'test/a.test.ts',
      new Map([
        [
          'src/add.mjs',
          [
            { startOffset: 0, endOffset: onDisk.length, count: 0 },
            { startOffset: 0, endOffset: ranTo, count: 1 },
          ],
        ],
      ]),
    ],
  ]);
  const scopes: (TestScope | undefined)[] = [];
  const testRun: TestRun = async (_at, _modules, _deadline, _signal, scope) => {
    scopes.push(scope);
    return scope?.coverage === true ? { ...ranTests, ...{ coverage } } : ranTests;
  };
  const treeOf: CommitTree = (_commit, use) => use(tree);
  const runner: BrewerRunner = {
    start: () => ({
      ended: Promise.resolve({
        ending: {
          kind: 'succeeded',
          output: { status: 'done', summary: 'Mutants', mutants: [{ ...clamps }] },
        },
      }),
      stop: () => {},
    }),
    progress: () => undefined,
  };
  const state = fold(events);
  const wrapped = mutated({
    runner,
    state: () => state,
    mutates: () => true,
    git,
    clone: () => clone,
    testMap: async () => ({
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
    }),
    tree: () => treeOf,
    testRun,
    platform: 'linux',
    clock: () => t0,
  });
  const limits = { outDoc: { file: 'mutants.md', schema: MutantsOutDoc }, blocking: false };
  const end = await wrapped.start({ ref, limits }).ended;
  return { scopes, verdicts: end.mutants?.map(({ verdict }) => verdict.kind) };
};

describe("mutated, the baseline's checked-out text (ADR 0431)", () => {
  // The first line and its break are 37 characters under CRLF, 36 under LF: a test file that ran
  // only the first line reaches the second one in the text the commit holds, and not in the tree's.
  const first = (lines[0] ?? '').length;

  it('reads the offsets against the file as the baseline tree holds it: a CRLF checkout shifts the lines', async () => {
    const { scopes, verdicts } = await judged(`${lines.join('\r\n')}\r\n`, first + 2);
    // Only the baseline ran: no test file ran the second line.
    assert.deepStrictEqual(scopes, [{ coverage: true }]);
    assert.deepStrictEqual(verdicts, ['survived']);
  });

  it('runs the test files that reached the line when the tree holds the file as the commit does', async () => {
    const { scopes, verdicts } = await judged(code, first + 2);
    assert.deepStrictEqual(scopes, [{ coverage: true }, { files: ['test/a.test.ts'] }]);
    assert.deepStrictEqual(verdicts, ['survived']);
  });
});
