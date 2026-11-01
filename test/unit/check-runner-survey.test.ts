// A survey's check (ADR 0282, ADR 0298): one run of the confirmed test line against the test map
// the Maltster proposed, before the Gauger starts. A run that disagrees with the map fails the check
// back to the survey while its route has rounds, then sticks the batch on its environment, naming
// what disagreed; a survey that found the map fresh needs no run. Through injected maps, report
// paths and process runner (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';
import type { MapRead } from '../../src/checks/test-map.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { TestMap } from '../../src/schemas/test-map.ts';

const deadlineAt = '2026-10-31T12:30:00.000Z';
const now = new Date('2026-10-31T12:00:00.000Z');
const base = 'a'.repeat(40);
const tip = 'c'.repeat(40);
const pathOf = (stepId: string, attempt: number) =>
  join('/work', 'acme.api', 'attempts', '12-1', stepId, String(attempt));

/** A finished attempt of `stepId`, started at `commit`, and its route when one sent it. */
const attempt = (
  stepId: string,
  number: number,
  commit: string,
  outcome: Extract<Event, { type: 'step.finished' }>['outcome'],
  route?: { from: string; why: 'failed' },
): Event[] => [
  {
    type: 'step.scheduled',
    batchId: '12-1',
    stepId,
    attempt: number,
    deadlineAt,
    ...(route === undefined ? {} : { route }),
  },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId,
    attempt: number,
    worktree: {
      repo: 'acme/api',
      path: pathOf(stepId, number),
      branch: `foedrum/12-1/${stepId}/${number}`,
      commit,
    },
  },
  { type: 'step.finished', batchId: '12-1', stepId, attempt: number, outcome },
];

const proposed = { status: 'done', summary: 'Proposed the test map', map: 'new' };
const back = { from: 'survey-check', why: 'failed' } as const;
const disagreed = {
  kind: 'failed',
  retryable: false,
  reason: 'the test map the survey proposed disagrees with a run of acme/api',
} as const;

const ordered: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'l', source: 'label' },
];

/** The survey-check's attempt `number`, started at the survey's tip. */
const checking = (number: number): Event[] => [
  { type: 'step.scheduled', batchId: '12-1', stepId: 'survey-check', attempt: number, deadlineAt },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId: 'survey-check',
    attempt: number,
    worktree: {
      repo: 'acme/api',
      path: pathOf('survey-check', number),
      branch: `foedrum/12-1/survey-check/${number}`,
      commit: tip,
    },
  },
];

/** The first round: the survey proposed a map, and its check runs. */
const firstRound: Event[] = [
  ...ordered,
  ...attempt('survey', 1, base, { kind: 'succeeded', output: proposed }),
  ...checking(1),
];

/** The last round: the check sent the survey back once, which proposed again. */
const lastRound: Event[] = [
  ...ordered,
  ...attempt('survey', 1, base, { kind: 'succeeded', output: proposed }),
  ...attempt('survey-check', 1, tip, disagreed),
  ...attempt('survey', 2, base, { kind: 'succeeded', output: proposed }, back),
  ...checking(2),
];

const repository: RepositoryChecks = {
  build: null,
  typecheck: null,
  lint: null,
  format: null,
  test: 'npm test',
};

const map: TestMap = {
  derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
  modules: [
    {
      name: 'api',
      code: ['src/**'],
      tests: { paths: ['test/**'] },
      testReport: { format: 'tap', path: 'reports/test.tap' },
      coverage: 'none',
    },
  ],
};

const setup = ({
  events = firstRound,
  /** The report paths each pattern finds in the worktree. */
  found = {} as Record<string, string[]>,
  testExit = 0,
  /** The test report foedrum.jsonc names. */
  testReport = undefined as { format: 'junit'; path: string } | undefined,
} = {}) => {
  const ran: string[] = [];
  const stepChecks: StepChecks = {
    find: (recipe, stepId) =>
      recipe === 'nip' && stepId === 'survey-check' ? ['test'] : undefined,
    any: () => true,
    proves: () => undefined,
    redProof: () => undefined,
    surveys: (recipe, stepId) =>
      recipe === 'nip' && stepId === 'survey-check' ? { of: 'survey', maxRounds: 1 } : undefined,
    surveyCheck: () => ({ id: 'survey-check', of: 'survey' }),
  };
  const maps: Record<string, MapRead> = { [base]: { kind: 'none' }, [tip]: { kind: 'map', map } };
  const runner = createCheckRunner({
    state: () => fold(events),
    checks: stepChecks,
    repositoryChecks: () => repository,
    testReport: () => testReport,
    exec: (file) => {
      ran.push(file);
      const output = 'ok 1 - lists the invoices\n';
      return Promise.resolve({ exitCode: testExit, stdout: output, stderr: '', output });
    },
    // The survey's change holds the test map only: no line of code to judge.
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    reports: { clear: () => {}, read: () => ({ kind: 'missing' }) },
    clone: () => join('/work', 'acme.api', 'clone.git'),
    env: { base: {}, forced: {} },
    clock: () => now,
    platform: 'linux',
    testMap: {
      at: async (_repo, commit) => maps[commit] ?? { kind: 'none' },
      reports: (pattern) => ({ paths: found[pattern] ?? [] }),
      keptIn: () => 'repo',
      manifests: async () => ({ kind: 'fresh' }),
      // The survey's change touched the map, as a survey's does.
      touched: async () => ({ paths: ['.foedrum/test-map.jsonc'] }),
    },
  });
  const ref = events.findLast((event) => event.type === 'step.started');
  assert.ok(ref?.type === 'step.started');
  const run = () =>
    runner.start({
      ref: { batchId: ref.batchId, stepId: ref.stepId, attempt: ref.attempt },
      limits: { outDoc: { file: 'out.md', schema: undefined as never } },
    }).ended;
  return { run, ran };
};

const reported = { 'reports/test.tap': [join(pathOf('survey-check', 1), 'reports', 'test.tap')] };

describe("createCheckRunner: a survey's check against one run (ADR 0298)", () => {
  it('passes a survey-check whose run writes its reports where the proposed map says: regression test', async () => {
    const { run, ran } = setup({ found: reported });
    const end = await run();
    assert.deepEqual(ran, ['npm test']);
    assert.equal(end.ending.kind, 'succeeded');
  });

  it('fails a survey-check whose run disagrees with the proposed map back to the survey', async () => {
    const { run } = setup();
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason:
        'the test map the survey proposed disagrees with a run of acme/api: module "api" wrote no test report at reports/test.tap (ADR 0298)',
    });
    // The readings stay as they ran.
    assert.deepEqual(
      end.readings?.map((reading) => [reading.check, reading.result]),
      [['test', 'exited']],
    );
  });

  it('fails a survey-check whose run writes a report outside the proposed map back to the survey', async () => {
    const outside = join(pathOf('survey-check', 1), 'out', 'junit.xml');
    const { run } = setup({
      found: { ...reported, 'out/junit.xml': [outside] },
      testReport: { format: 'junit', path: 'out/junit.xml' },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason:
        'the test map the survey proposed disagrees with a run of acme/api: out/junit.xml (a report outside the map) (ADR 0298)',
    });
  });

  it('sticks the batch on its environment when no proposed map agrees with a run', async () => {
    const { run } = setup({ events: lastRound });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'no test map the survey proposed agrees with a run of acme/api: module "api" wrote no test report at reports/test.tap (ADR 0298)',
    });
  });

  it('sticks the batch on its environment when the run under the proposed map fails in its last round', async () => {
    const { run } = setup({ events: lastRound, testExit: 1 });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'no test map the survey proposed agrees with a run of acme/api: the check "test" (npm test) failed with exit code 1 (ADR 0298)',
    });
  });

  it("skips the survey-check's run when the survey found the map fresh", async () => {
    const fresh = { status: 'done', summary: 'The test map is fresh', map: 'fresh' };
    const events = [
      ...ordered,
      ...attempt('survey', 1, base, { kind: 'succeeded', output: fresh }),
      ...checking(1),
    ];
    const { run, ran } = setup({ events });
    const end = await run();
    assert.deepEqual(ran, []);
    assert.deepEqual(end, { ending: { kind: 'succeeded', output: null } });
  });
});
