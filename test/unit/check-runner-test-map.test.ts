// A module the batch's test map adds that no confirmed line reaches (ADR 0274): after a check step's
// test check ran, a module only the batch's map lists whose report path holds no report sticks the
// batch on its environment, through injected maps, report paths and process runner (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';
import type { MapRead } from '../../src/checks/test-map.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { CheckRef } from '../../src/schemas/recipe.ts';
import type { TestMap, TestMapModule } from '../../src/schemas/test-map.ts';

const worktree = join('/work', 'acme.api', 'attempts', '12-1', 'green', '1');
const ref = { batchId: '12-1', stepId: 'green', attempt: 1 };
const now = new Date('2026-10-31T12:00:00.000Z');
const deadlineAt = '2026-10-31T12:30:00.000Z';
const base = 'a'.repeat(40);
const tip = 'c'.repeat(40);

// The batch started at the base with its implement step, and its check step runs at its tip.
const events: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'pale', reason: 'l', source: 'label' },
  { type: 'step.scheduled', batchId: '12-1', stepId: 'implement', attempt: 1, deadlineAt },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    worktree: { repo: 'acme/api', path: join(worktree, 'i'), branch: 'b/i', commit: base },
  },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    outcome: { kind: 'succeeded', output: null },
  },
  { type: 'step.scheduled', ...ref, deadlineAt },
  {
    type: 'step.started',
    ...ref,
    worktree: { repo: 'acme/api', path: worktree, branch: 'foedrum/12-1/green/1', commit: tip },
  },
];

const repository: RepositoryChecks = {
  build: null,
  typecheck: 'npm run typecheck',
  lint: null,
  format: null,
  test: 'npm test',
};

const web: TestMapModule = {
  name: 'web',
  code: ['web/src/**'],
  tests: { paths: ['web/test/**'] },
  testReport: { format: 'junit', path: 'web/test-results.xml' },
  coverage: { format: 'lcov', path: 'web/coverage/lcov.info' },
};
const billing: TestMapModule = {
  name: 'billing',
  code: ['svc/src/**'],
  tests: { projects: [{ path: 'svc/test/Billing.Tests' }] },
  testReport: { format: 'trx', path: 'svc/test/*/TestResults' },
  coverage: { format: 'cobertura', path: 'svc/test/*/TestResults' },
};
const mapOf = (...modules: TestMapModule[]): MapRead => ({
  kind: 'map',
  map: { derivedFrom: { globs: ['**/*.csproj'], paths: [] }, modules } satisfies TestMap,
});

const compileError = 'svc/test/Billing.Tests/InvoiceTests.cs(3,1): error CS1002: ; expected';

const setup = ({
  checks = ['typecheck', 'test'] as readonly CheckRef[],
  /** The batch's events up to the check step's start. */
  started = events,
  /** Events after the check step started, such as a merge of the base. */
  more = [] as Event[],
  maps = { [base]: mapOf(web), [tip]: mapOf(web, billing) } as Record<string, MapRead>,
  /** The report paths each pattern finds in the worktree. */
  found = { 'web/test-results.xml': [join(worktree, 'web', 'test-results.xml')] } as Record<
    string,
    string[]
  >,
  /** Why a pattern is refused, by pattern. */
  refused = {} as Record<string, string>,
  /** null: the test check was killed at its deadline. */
  testExit = 1 as number | null,
} = {}) => {
  const asked: string[] = [];
  const exec: ExecProcess = (file) => {
    const output = file === 'npm test' ? `Build FAILED.\n${compileError}\n` : '';
    if (file === 'npm test' && testExit === null) {
      const killed = 'timed-out' as const;
      return Promise.resolve({ exitCode: null, stdout: output, stderr: '', output, killed });
    }
    const exitCode = file === 'npm test' ? testExit : 0;
    return Promise.resolve({ exitCode, stdout: output, stderr: '', output });
  };
  const stepChecks: StepChecks = {
    find: (recipe, stepId) => (recipe === 'pale' && stepId === 'green' ? checks : undefined),
    any: () => true,
    proves: () => undefined,
    redProof: () => undefined,
  };
  const runner = createCheckRunner({
    state: () => fold([...started, ...more]),
    checks: stepChecks,
    repositoryChecks: () => repository,
    testReport: () => undefined,
    exec,
    git: () => Promise.reject(new Error('the maps come from testMap')),
    clone: () => join('/work', 'acme.api', 'clone.git'),
    env: { base: {}, forced: {} },
    clock: () => now,
    platform: 'linux',
    testMap: {
      at: async (repo, commit) => {
        asked.push(`map of ${repo} at ${commit}`);
        return maps[commit] ?? { kind: 'none' };
      },
      reports: (pattern, root) => {
        asked.push(`reports ${pattern} in ${root}`);
        const why = refused[pattern];
        return why === undefined ? { paths: found[pattern] ?? [] } : { refused: why };
      },
    },
  });
  const run = () =>
    runner.start({ ref, limits: { outDoc: { file: 'out.md', schema: undefined as never } } }).ended;
  return { run, asked };
};

describe('createCheckRunner: a module no confirmed line reaches (ADR 0274)', () => {
  it('sticks the batch on its environment for a new module no confirmed line reaches, naming the line to add', async () => {
    const { run, asked } = setup();
    const end = await run();
    assert.equal(end.ending.kind, 'blocked');
    const { blockerKind, summary } = end.ending.kind === 'blocked' ? end.ending : assert.fail();
    assert.equal(blockerKind, 'environment');
    assert.match(summary, /module "billing" of the test map is new in this batch/);
    assert.match(summary, /no test report at svc\/test\/\*\/TestResults/);
    assert.match(
      summary,
      /make "checks"\."test" of acme\/api in foedrum\.jsonc also run its tests, such as "npm test && <billing's test command>"/,
    );
    // The check's recorded output tail, so the compile error shows.
    assert.ok(summary.includes(compileError), summary);
    // The readings stay as they ran.
    assert.deepEqual(
      end.readings?.map((reading) => [reading.check, reading.result]),
      [
        ['typecheck', 'exited'],
        ['test', 'exited'],
      ],
    );
    assert.deepEqual(asked, [
      `map of acme/api at ${base}`,
      `map of acme/api at ${tip}`,
      `reports svc/test/*/TestResults in ${worktree}`,
    ]);
  });

  it("takes a module the base's map lists as reached: its missing report is no Stuck", async () => {
    const { run } = setup({ maps: { [base]: mapOf(web, billing), [tip]: mapOf(web, billing) } });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
  });

  it('takes a new module whose report the run wrote as reached', async () => {
    const reports = [join(worktree, 'svc', 'test', 'Billing.Tests', 'TestResults')];
    const { run } = setup({ found: { 'svc/test/*/TestResults': reports }, testExit: 0 });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
  });

  it('reads no map for a check step that ran no test check', async () => {
    const { run, asked } = setup({ checks: ['typecheck'] });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(asked, []);
  });

  it('reads no map for a test check that did not exit', async () => {
    const { run, asked } = setup({ testExit: null });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
    assert.deepEqual(asked, []);
  });

  it('finds the start of a repository whose worktree names it in another case: regression test', async () => {
    const renamed = events.map(
      (event): Event =>
        event.type === 'step.started' && event.worktree !== undefined
          ? { ...event, worktree: { ...event.worktree, repo: 'Acme/API' } }
          : event,
    );
    const maps = { [base]: mapOf(web, billing), [tip]: mapOf(web, billing) };
    const { run, asked } = setup({ started: renamed, maps });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
    assert.deepEqual(asked, [`map of Acme/API at ${base}`, `map of Acme/API at ${tip}`]);
  });

  it('takes the base the batch merged as the base of its map (ADR 0164)', async () => {
    const merged = 'e'.repeat(40);
    const key = effectKey.encode(
      baseMergeKey({ batchId: '12-1', stepId: 'implement', attempt: 1 }),
    );
    const more: Event[] = [
      { type: 'effect.applied', key, result: { base: merged, merged: 'f'.repeat(40) } },
    ];
    // The merged base lists billing: it is the base's, so taken as reached.
    const maps = { [base]: mapOf(web), [merged]: mapOf(web, billing), [tip]: mapOf(web, billing) };
    const { run, asked } = setup({ more, maps });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
    assert.deepEqual(asked, [`map of acme/api at ${merged}`, `map of acme/api at ${tip}`]);
  });

  it("sticks the batch on its environment when the base's map cannot be read", async () => {
    const { run } = setup({
      maps: { [base]: { kind: 'unreadable', reason: 'it is not JSONC' }, [tip]: mapOf(web) },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the test map of acme/api at ${base} cannot be read: it is not JSONC`,
    });
  });

  it("fails the step for its onFail route when the batch's map cannot be read: its brewer fixes it", async () => {
    const { run } = setup({
      maps: { [base]: mapOf(web), [tip]: { kind: 'unreadable', reason: 'it is not JSONC' } },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason: `the test map of acme/api at ${tip} cannot be read: it is not JSONC`,
    });
  });

  it("sticks the batch on its environment when a new module's report path is refused", async () => {
    const why = 'svc/test/*/TestResults leads out of the worktree';
    const { run } = setup({ refused: { 'svc/test/*/TestResults': why } });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the test report of module "billing" cannot be looked for: ${why}`,
    });
  });
});
