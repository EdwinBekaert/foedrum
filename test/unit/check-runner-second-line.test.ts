// A second test line's coverage reaches the uncovered-line check only where the step ran the
// line (#1175, ADR 0430): a test map a repository's Breweries share may name a second report that
// one of them never writes, and a survey's check runs no second line. Through an injected git, maps,
// report paths and process runner (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';
import type { MapRead } from '../../src/checks/test-map.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import { parseLcov } from '../../src/formats/lcov.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { TestMap } from '../../src/schemas/test-map.ts';

const deadlineAt = '2026-10-31T12:30:00.000Z';
const now = new Date('2026-10-31T12:00:00.000Z');
const base = 'a'.repeat(40);
const tip = 'c'.repeat(40);
const clone = join('/work', 'acme.api', 'clone.git');
const worktreeOf = (stepId: string) => join('/work', 'acme.api', 'attempts', '12-1', stepId, '1');
const integration = 'npm run integration';

const repository: RepositoryChecks = {
  build: null,
  typecheck: null,
  lint: null,
  format: null,
  test: 'npm test',
};

// One module whose second line writes second.info, and a change that adds line 3 of its code.
const map: TestMap = {
  derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
  modules: [
    {
      name: 'api',
      code: ['src/**'],
      tests: { paths: ['test/**'] },
      testReport: { format: 'tap', path: 'reports/test.tap' },
      coverage: { format: 'lcov', path: 'lcov.info' },
      coverageSecond: { format: 'lcov', path: 'second.info' },
    },
  ],
};
const diff = [
  'diff --git a/src/calc.ts b/src/calc.ts',
  '--- a/src/calc.ts',
  '+++ b/src/calc.ts',
  '@@ -2,0 +3,1 @@',
  '+line 3',
  '',
].join('\n');

/** The events of a batch whose `stepId` runs at the tip, after an implement step at the base. */
const eventsOf = (recipe: string, stepId: string, before: Event[] = []): Event[] => [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe, reason: 'l', source: 'label' },
  ...before,
  { type: 'step.scheduled', batchId: '12-1', stepId, attempt: 1, deadlineAt },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId,
    attempt: 1,
    worktree: {
      repo: 'acme/api',
      path: worktreeOf(stepId),
      branch: `foedrum/12-1/${stepId}/1`,
      commit: tip,
    },
  },
];
const implemented: Event[] = [
  { type: 'step.scheduled', batchId: '12-1', stepId: 'implement', attempt: 1, deadlineAt },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    worktree: {
      repo: 'acme/api',
      path: worktreeOf('implement'),
      branch: 'foedrum/12-1/implement/1',
      commit: base,
    },
  },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    outcome: { kind: 'succeeded', output: null },
  },
];
const proposed = { status: 'done', summary: 'Proposed the test map', map: 'new' };
const surveyed: Event[] = [
  { type: 'step.scheduled', batchId: '12-1', stepId: 'survey', attempt: 1, deadlineAt },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId: 'survey',
    attempt: 1,
    worktree: {
      repo: 'acme/api',
      path: worktreeOf('survey'),
      branch: 'foedrum/12-1/survey/1',
      commit: base,
    },
  },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'survey',
    attempt: 1,
    outcome: { kind: 'succeeded', output: proposed },
  },
];

const setup = ({
  recipe,
  stepId,
  before,
  checksOf,
  survey = false,
}: {
  recipe: string;
  stepId: string;
  before: Event[];
  checksOf: RepositoryChecks;
  survey?: boolean;
}) => {
  const events = eventsOf(recipe, stepId, before);
  const asked: string[] = [];
  const stepChecks: StepChecks = {
    find: (name, id) => (name === recipe && id === stepId ? ['test'] : undefined),
    any: () => true,
    proves: () => undefined,
    redProof: () => undefined,
    ...(survey
      ? {
          surveys: (name: string, id: string) =>
            name === recipe && id === stepId ? { of: 'survey', maxRounds: 1 } : undefined,
          surveyCheck: () => ({ id: stepId, of: 'survey' }),
        }
      : {}),
  };
  const maps: Record<string, MapRead> = {
    [base]: survey ? { kind: 'none' } : { kind: 'map', map },
    [tip]: { kind: 'map', map },
  };
  const runner = createCheckRunner({
    state: () => fold(events),
    checks: stepChecks,
    repositoryChecks: () => checksOf,
    testReport: () => undefined,
    exec: (line) => {
      asked.push(`run ${line}`);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', output: '' });
    },
    git: async (_cwd, args) =>
      args.includes('diff')
        ? { code: 0, stdout: diff, stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    clone: () => clone,
    reports: { clear: () => {}, read: () => ({ kind: 'missing' }) },
    env: { base: {}, forced: {} },
    clock: () => now,
    platform: 'linux',
    testMap: {
      at: async (_repo, commit) => maps[commit] ?? { kind: 'none' },
      // Every report path is found, so a survey's run agrees with its map.
      reports: (pattern) => ({ paths: [join(worktreeOf(stepId), ...pattern.split('/'))] }),
      coverage: (_format, path) => {
        asked.push(`coverage ${path}`);
        // Only the test line wrote a report: the second line's path reads none.
        return path === 'lcov.info'
          ? parseLcov(['SF:src/calc.ts', 'DA:3,1', 'end_of_record'].join('\n'), worktreeOf(stepId))
          : { readable: false, reason: `no report at ${path}` };
      },
      isFolder: () => false,
      keptIn: () => 'repo',
      manifests: async () => ({ kind: 'fresh' }),
      touched: async () => ({ paths: ['.foedrum/test-map.jsonc'] }),
    },
  });
  const run = () =>
    runner.start({
      ref: { batchId: '12-1', stepId, attempt: 1 },
      limits: { outDoc: { file: 'out.md', schema: undefined as never } },
    }).ended;
  return { run, asked };
};

describe("createCheckRunner: a map's second coverage report without a second test line (ADR 0430)", () => {
  const plain = { recipe: 'pale', stepId: 'green', before: implemented };

  it('reads no second report of a module when the repository sets no testSecond', async () => {
    const { run, asked } = setup({ ...plain, checksOf: repository });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    // The test line's own report is read, the second line's never is.
    assert.ok(asked.includes('coverage lcov.info'), asked.join('\n'));
    assert.ok(!asked.includes('coverage second.info'), asked.join('\n'));
  });

  it('reads the second report of the module when the repository sets testSecond: the near miss', async () => {
    const { run, asked } = setup({
      ...plain,
      checksOf: { ...repository, testSecond: integration },
    });
    const end = await run();
    assert.ok(asked.includes(`run ${integration}`), asked.join('\n'));
    assert.ok(asked.includes('coverage second.info'), asked.join('\n'));
    assert.match(
      end.ending.kind === 'failed' ? end.ending.reason : '',
      /no report at second\.info/,
    );
  });

  it("runs no second line in a survey's check, and reads no second report there", async () => {
    const { run, asked } = setup({
      recipe: 'nip',
      stepId: 'survey-check',
      before: [...implemented, ...surveyed],
      checksOf: { ...repository, testSecond: integration },
      survey: true,
    });
    const end = await run();
    assert.ok(!asked.includes(`run ${integration}`), asked.join('\n'));
    assert.ok(!asked.includes('coverage second.info'), asked.join('\n'));
    assert.equal(end.ending.kind, 'succeeded', JSON.stringify(end.ending));
  });
});
