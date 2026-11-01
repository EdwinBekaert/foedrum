// A module the batch's test map adds that no confirmed line reaches (ADR 0274): after a check step's
// test check ran, a module only the batch's map lists whose report path holds no report sticks the
// batch on its environment, through injected maps, report paths and process runner (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';
import type { ManifestFreshness, MapRead } from '../../src/checks/test-map.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
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
  coverage: { format: 'cobertura', path: 'svc/coverage/*' },
};
const py: TestMapModule = {
  name: 'py',
  code: ['py/src/**'],
  tests: { paths: ['py/tests/**'] },
  testReport: { format: 'junit', path: 'py/report.xml' },
  coverage: 'none',
};
/** A JUnit report of `tests`, each placed at its file and line where given. */
const junitOf = (...tests: { name: string; file?: string }[]): string =>
  `<testsuites><testsuite name="all">${tests
    .map(
      ({ name, file }) =>
        `<testcase name="${name}"${file === undefined ? '' : ` file="${file}" line="3"`}/>`,
    )
    .join('')}</testsuite></testsuites>`;
const webReport = join(worktree, 'web', 'test-results.xml');
const pyReport = join(worktree, 'py', 'report.xml');

const mapOf = (...modules: TestMapModule[]): MapRead => ({
  kind: 'map',
  map: { derivedFrom: { globs: ['**/*.csproj'], paths: [] }, modules } satisfies TestMap,
});

// Before the test check runs, the coverage report paths of both maps' modules are looked for, to
// be cleared, and neither holds a report here; then the test report paths but TRX's, which no
// reader reads (#727). The batch's change adds no test line, so no test report is read after it.
const clearing = [
  `reports web/coverage/lcov.info in ${worktree}`,
  `reports svc/coverage/* in ${worktree}`,
  `reports web/test-results.xml in ${worktree}`,
  `clear ${join(worktree, 'web', 'test-results.xml')}`,
];

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
  testExit = 0 as number | null,
  /** Where the map is kept (ADR 0018). */
  keptIn = 'repo' as 'repo' | 'brewery',
  /** The tip map's manifests against the worktree's files. */
  manifests = { kind: 'fresh' } as ManifestFreshness,
  /** The paths among the map and its globs that the batch's change touched. */
  touched = [] as string[] | { unread: string },
  /** The test report foedrum.jsonc names. */
  testReport = undefined as { format: 'junit'; path: string } | undefined,
  /** The text of each test report file the run wrote, by its path. */
  texts = {} as Record<string, string>,
  /** The files of the worktree, relative to its root, that a test's location may name. */
  files = [] as string[],
  /** The worktree's real path, when a link leads to it. */
  real = worktree,
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
    testReport: () => testReport,
    exec,
    // The batch's change is empty: the uncovered-line check has no line to judge.
    git: async (_cwd, args) =>
      args.includes('diff')
        ? { code: 0, stdout: '', stderr: '' }
        : Promise.reject(new Error('the maps come from testMap')),
    reports: {
      clear: (file) => {
        asked.push(`clear ${file}`);
      },
      read: (file) => {
        const text = texts[file];
        return text === undefined ? { kind: 'missing' } : { kind: 'text', text };
      },
    },
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
      keptIn: () => keptIn,
      manifests: async (root, map) => {
        asked.push(`manifests ${map.derivedFrom.globs.join(' ')} in ${root}`);
        return manifests;
      },
      touched: async (repo, from, to, paths) => {
        asked.push(`touched ${paths.join(' ')} in ${repo} from ${from} to ${to}`);
        return Array.isArray(touched) ? { paths: touched } : touched;
      },
      realPath: () => real,
      exists: (path) => files.some((file) => join(worktree, file) === path),
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
      /make "checks"\."test" of acme\/api in foedrum\.jsonc, now "npm test", also run its tests, whatever the tests before them give/,
    );
    // The check's recorded output tail.
    assert.ok(summary.includes(compileError), summary);
    // The readings stay as they ran.
    assert.deepEqual(
      end.readings?.map((reading) => [reading.check, reading.result]),
      [
        ['typecheck', 'exited'],
        ['test', 'exited'],
      ],
    );
    // The tip's map is read once, for its manifests before the run (ADR 0282).
    assert.deepEqual(asked, [
      `map of acme/api at ${tip}`,
      `manifests **/*.csproj in ${worktree}`,
      `map of acme/api at ${base}`,
      ...clearing,
      `reports svc/test/*/TestResults in ${worktree}`,
    ]);
  });

  it("takes a module the base's map lists as reached: its missing report is no Stuck", async () => {
    const { run } = setup({ maps: { [base]: mapOf(web, billing), [tip]: mapOf(web, billing) } });
    const end = await run();
    assert.equal(end.ending.kind, 'succeeded');
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

  it('judges a new module unreached only on a passing test reading: a failing run goes along onFail (ADR 0280)', async () => {
    const { run, asked } = setup({ testExit: 1 });
    const end = await run();
    assert.deepEqual(
      end.ending.kind === 'failed' ? [end.ending.kind, end.ending.retryable] : end.ending,
      ['failed', false],
    );
    // The manifests before the run, and nothing of the map after it.
    assert.deepEqual(asked, [
      `map of acme/api at ${tip}`,
      `manifests **/*.csproj in ${worktree}`,
      `map of acme/api at ${base}`,
      ...clearing,
    ]);
  });

  it("looks for no new module's report for a test check that did not exit", async () => {
    const { run, asked } = setup({ testExit: null });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
    assert.deepEqual(asked, [
      `map of acme/api at ${tip}`,
      `manifests **/*.csproj in ${worktree}`,
      `map of acme/api at ${base}`,
      ...clearing,
    ]);
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
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(asked, [
      `map of Acme/API at ${tip}`,
      `manifests **/*.csproj in ${worktree}`,
      `map of Acme/API at ${base}`,
      ...clearing,
      `reports web/test-results.xml in ${worktree}`,
      `reports svc/test/*/TestResults in ${worktree}`,
      // Its tests' locations, read for staleness (ADR 0282).
      `reports web/test-results.xml in ${worktree}`,
    ]);
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
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(asked, [
      `map of acme/api at ${tip}`,
      `manifests **/*.csproj in ${worktree}`,
      `map of acme/api at ${merged}`,
      ...clearing,
      `reports web/test-results.xml in ${worktree}`,
      `reports svc/test/*/TestResults in ${worktree}`,
      // Its tests' locations, read for staleness (ADR 0282).
      `reports web/test-results.xml in ${worktree}`,
    ]);
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

describe('createCheckRunner: a stale test map (ADR 0274, ADR 0282)', () => {
  const fresh = { [base]: mapOf(web), [tip]: mapOf(web) };
  const stale: ManifestFreshness = {
    kind: 'stale',
    added: ['svc/test/Billing.Tests/Billing.Tests.csproj'],
    removed: ['old/Old.csproj'],
  };
  const named = ['svc/test/Billing.Tests/Billing.Tests.csproj (added)', 'old/Old.csproj (removed)'];

  it('a step whose tip leaves the map stale by manifests fails back along onFail naming the paths', async () => {
    const { run, asked } = setup({
      maps: fresh,
      manifests: stale,
      touched: ['svc/test/Billing.Tests/Billing.Tests.csproj'],
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason:
        'the test map of acme/api is stale: its derivedFrom.globs match ' +
        'svc/test/Billing.Tests/Billing.Tests.csproj (added), old/Old.csproj (removed); ' +
        'update .foedrum/test-map.jsonc in this change (ADR 0274, ADR 0282)',
    });
    // Before the run: no check ran.
    assert.equal(end.readings, undefined);
    assert.deepEqual(asked, [
      `map of acme/api at ${tip}`,
      `manifests **/*.csproj in ${worktree}`,
      `touched .foedrum/test-map.jsonc **/*.csproj in acme/api from ${base} to ${tip}`,
    ]);
  });

  it('records a map the batch did not make stale without failing the step', async () => {
    const { run } = setup({ maps: fresh, manifests: stale, touched: [] });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(end.staleMap, { repo: 'acme/api', kept: 'repo', paths: named, more: 0 });
  });

  it('finds the map stale when a run writes a report outside every module', async () => {
    const { run } = setup({
      maps: fresh,
      testReport: { format: 'junit', path: 'out/results.xml' },
      found: {
        'web/test-results.xml': [join(worktree, 'web', 'test-results.xml')],
        'out/results.xml': [join(worktree, 'out', 'results.xml')],
      },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(end.staleMap, {
      repo: 'acme/api',
      kept: 'repo',
      paths: ['out/results.xml (a report outside the map)'],
      more: 0,
    });
  });

  it("finds the map stale when a passing run writes no report where the map says a module's is", async () => {
    const { run } = setup({ maps: fresh, found: {} });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(end.staleMap, {
      repo: 'acme/api',
      kept: 'repo',
      paths: ['web/test-results.xml (no report of module "web")'],
      more: 0,
    });
  });

  it('finds the map stale when a run reports a test located outside every module', async () => {
    const { run } = setup({
      maps: fresh,
      found: { 'web/test-results.xml': [webReport] },
      texts: {
        [webReport]: junitOf(
          { name: 'greets', file: 'greets.test.mjs' },
          { name: 'renders', file: 'web/test/render.test.mjs' },
          { name: 'greets twice', file: 'greets.test.mjs' },
        ),
      },
      files: ['greets.test.mjs', 'web/test/render.test.mjs'],
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    // One reason per file, naming its first test.
    assert.deepEqual(end.staleMap, {
      repo: 'acme/api',
      kept: 'repo',
      paths: ['test greets at greets.test.mjs outside the map'],
      more: 0,
    });
  });

  it("finds the map stale when a run reports a test at an absolute location under the worktree's real path", async () => {
    const real = join('/private', 'work', 'acme.api', 'green');
    const { run } = setup({
      maps: fresh,
      real,
      found: { 'web/test-results.xml': [webReport] },
      texts: {
        [webReport]: junitOf(
          { name: 'renders', file: join(real, 'web', 'test', 'render.test.mjs') },
          { name: 'greets', file: join(real, 'tools', 'greets.test.mjs') },
        ),
      },
    });
    const end = await run();
    assert.deepEqual(end.staleMap?.paths, ['test greets at tools/greets.test.mjs outside the map']);
  });

  it("finds the map stale when a module's relative test location names a file at the root outside the map", async () => {
    const { run } = setup({
      maps: { [base]: mapOf(web, py), [tip]: mapOf(web, py) },
      found: { 'web/test-results.xml': [webReport], 'py/report.xml': [pyReport] },
      texts: { [pyReport]: junitOf({ name: 'test_adds', file: 'tests/test_x.py' }) },
      files: ['tests/test_x.py'],
    });
    const end = await run();
    assert.deepEqual(end.staleMap?.paths, ['test test_adds at tests/test_x.py outside the map']);
  });

  it('names no test the report places nowhere: regression test', async () => {
    const { run } = setup({
      maps: fresh,
      texts: { [webReport]: junitOf({ name: 'greets' }) },
      files: ['greets.test.mjs'],
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(end.staleMap, undefined);
  });

  it("takes a module's relative test location written from its folder as inside the map: regression test", async () => {
    const { run } = setup({
      maps: { [base]: mapOf(web, py), [tip]: mapOf(web, py) },
      found: { 'web/test-results.xml': [webReport], 'py/report.xml': [pyReport] },
      texts: { [pyReport]: junitOf({ name: 'test_adds', file: 'tests/test_x.py' }) },
      files: ['py/tests/test_x.py'],
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(end.staleMap, undefined);
  });

  it("reads a relative location from no other module's folder: regression test", async () => {
    // The file is under web's folder, outside its areas, not py's: py's report cannot place it there.
    const { run } = setup({
      maps: { [base]: mapOf(web, py), [tip]: mapOf(web, py) },
      found: { 'web/test-results.xml': [webReport], 'py/report.xml': [pyReport] },
      texts: { [pyReport]: junitOf({ name: 'test_adds', file: 'scripts/x.py' }) },
      files: ['web/scripts/x.py'],
    });
    const end = await run();
    assert.equal(end.staleMap, undefined);
  });

  it('names no relative location that resolves to no file of the worktree: regression test', async () => {
    const { run } = setup({
      maps: fresh,
      texts: { [webReport]: junitOf({ name: 'greets', file: 'gone/greets.test.mjs' }) },
    });
    const end = await run();
    assert.equal(end.staleMap, undefined);
  });

  it('names nothing of a test report that cannot be read, and passes the step: regression test', async () => {
    const { run } = setup({
      maps: fresh,
      texts: { [webReport]: 'not a report' },
      files: ['greets.test.mjs'],
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(end.staleMap, undefined);
  });

  it('names a located test beside the two other run reasons: regression test', async () => {
    const { run } = setup({
      maps: { [base]: mapOf(web, py), [tip]: mapOf(web, py) },
      testReport: { format: 'junit', path: 'out/results.xml' },
      found: {
        'web/test-results.xml': [webReport],
        'out/results.xml': [join(worktree, 'out', 'results.xml')],
      },
      texts: { [webReport]: junitOf({ name: 'greets', file: 'greets.test.mjs' }) },
      files: ['greets.test.mjs'],
    });
    const end = await run();
    assert.deepEqual(end.staleMap?.paths, [
      'py/report.xml (no report of module "py")',
      'test greets at greets.test.mjs outside the map',
      'out/results.xml (a report outside the map)',
    ]);
  });

  it('names a stale Brewery-kept map in the status comment without failing the step', async () => {
    const { run, asked } = setup({
      maps: fresh,
      keptIn: 'brewery',
      manifests: stale,
      touched: ['svc/test/Billing.Tests/Billing.Tests.csproj'],
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    const staleMap = { repo: 'acme/api', kept: 'brewery' as const, paths: named, more: 0 };
    assert.deepEqual(end.staleMap, staleMap);
    // A batch cannot change the Brewery's map, so what its change touched is not read.
    assert.deepEqual(
      asked.filter((line) => line.startsWith('touched')),
      [],
    );
    const finished: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'succeeded', output: null },
      staleMap,
    };
    const batch = fold([...events, finished]).batches.get('12-1') ?? assert.fail();
    assert.ok(
      renderStatus(batch).includes(
        "The Brewery's test map of acme/api is stale: svc/test/Billing.Tests/Billing.Tests.csproj (added), old/Old.csproj (removed)",
      ),
      renderStatus(batch),
    );
    // Without the stale map, no such line.
    const { staleMap: _, ...without } = finished;
    const plain = fold([...events, without]).batches.get('12-1') ?? assert.fail();
    assert.ok(
      !renderStatus(plain).includes("The Brewery's test map of acme/api is stale"),
      renderStatus(plain),
    );
  });

  it('a fresh map passes every step as before: regression test', async () => {
    const { run } = setup({ maps: fresh });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(end.staleMap, undefined);
    assert.deepEqual(
      end.readings?.map((reading) => [reading.check, reading.result]),
      [
        ['typecheck', 'exited'],
        ['test', 'exited'],
      ],
    );
  });

  it('a repository with no test map brews as before: regression test', async () => {
    const { run, asked } = setup({ maps: {}, manifests: stale, touched: ['a.csproj'] });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(end.staleMap, undefined);
    assert.deepEqual(
      asked.filter((line) => line.startsWith('manifests') || line.startsWith('touched')),
      [],
    );
  });

  it('records no stale map for a repository with no test map whose run writes its test report', async () => {
    const { run } = setup({
      maps: {},
      testReport: { format: 'junit', path: 'out/results.xml' },
      found: { 'out/results.xml': [join(worktree, 'out', 'results.xml')] },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(end.staleMap, undefined);
  });

  it('names ten stale paths and counts the rest: regression test', async () => {
    const many: ManifestFreshness = {
      kind: 'stale',
      added: Array.from({ length: 12 }, (_, at) => `p${at}/App.csproj`),
      removed: [],
    };
    const recorded = await setup({ maps: fresh, manifests: many }).run();
    assert.equal(recorded.staleMap?.paths.length, 10);
    assert.equal(recorded.staleMap?.paths[9], 'p9/App.csproj (added)');
    assert.equal(recorded.staleMap?.more, 2);
    const failed = await setup({ maps: fresh, manifests: many, touched: ['p0/App.csproj'] }).run();
    const reason = failed.ending.kind === 'failed' ? failed.ending.reason : assert.fail();
    assert.match(reason, /p8\/App\.csproj \(added\), p9\/App\.csproj \(added\) and 2 more;/);
    assert.ok(!reason.includes('p10/'), reason);
  });

  it('records a map stale by manifests on a failing run, and judges nothing by that run: regression test', async () => {
    const { run } = setup({ maps: fresh, manifests: stale, found: {}, testExit: 1 });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
    assert.deepEqual(end.staleMap, { repo: 'acme/api', kept: 'repo', paths: named, more: 0 });
  });

  it('blocks the step on its environment when the manifests cannot be listed: regression test', async () => {
    const { run } = setup({
      maps: fresh,
      manifests: { kind: 'unread', reason: 'fatal: bad index' },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the manifests of the test map of acme/api cannot be listed: fatal: bad index',
    });
  });

  it("blocks the step on its environment when the change's files cannot be read: regression test", async () => {
    const { run } = setup({
      maps: fresh,
      manifests: stale,
      touched: { unread: 'fatal: bad object' },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the files the change of acme/api touched cannot be read: fatal: bad object',
    });
  });

  it('reads no map for a check step that runs no test check, though its manifests are stale: regression test', async () => {
    const { run, asked } = setup({ checks: ['typecheck'], maps: fresh, manifests: stale });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(asked, []);
  });

  it('a later run of the tests that finds the map fresh takes the stale line off the status comment: regression test', async () => {
    const staleMap = { repo: 'acme/api', kept: 'repo' as const, paths: named, more: 0 };
    const finished: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'failed', retryable: false, reason: 'red' },
      staleMap,
    };
    const stale = fold([...events, finished]).batches.get('12-1') ?? assert.fail();
    assert.ok(
      renderStatus(stale).includes('The test map of acme/api is stale: '),
      renderStatus(stale),
    );
    const again: Event[] = [
      { type: 'step.scheduled', ...ref, attempt: 2, deadlineAt, retry: true },
      {
        type: 'step.started',
        ...ref,
        attempt: 2,
        worktree: { repo: 'acme/api', path: worktree, branch: 'foedrum/12-1/green/2', commit: tip },
      },
      {
        type: 'step.finished',
        ...ref,
        attempt: 2,
        outcome: { kind: 'succeeded', output: null },
        readings: [{ result: 'exited', check: 'test', command: 'npm test', exitCode: 0, tail: '' }],
      },
    ];
    const fresh = fold([...events, finished, ...again]).batches.get('12-1') ?? assert.fail();
    assert.ok(
      !renderStatus(fresh).includes('The test map of acme/api is stale'),
      renderStatus(fresh),
    );
  });

  it("names no report under a module's test report or coverage path, nor one the run did not write: regression test", async () => {
    const webReport = join(worktree, 'web', 'test-results.xml');
    for (const [path, found] of [
      ['web/test-results.xml', { 'web/test-results.xml': [webReport] }],
      [
        'web/coverage/lcov.info',
        {
          'web/test-results.xml': [webReport],
          'web/coverage/lcov.info': [join(worktree, 'web', 'coverage', 'lcov.info')],
        },
      ],
      ['out/results.xml', { 'web/test-results.xml': [webReport] }],
    ] as [string, Record<string, string[]>][]) {
      const { run } = setup({ maps: fresh, testReport: { format: 'junit', path }, found });
      const end = await run();
      assert.deepEqual(end.ending, { kind: 'succeeded', output: null }, path);
      assert.equal(end.staleMap, undefined, path);
    }
  });

  it('keeps the stale line past a later attempt that ran no tests: regression test', () => {
    const finished: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'failed', retryable: false, reason: 'red' },
      staleMap: { repo: 'acme/api', kept: 'repo', paths: named, more: 0 },
    };
    const later: Event[] = [
      { type: 'step.scheduled', ...ref, attempt: 2, deadlineAt, retry: true },
      {
        type: 'step.started',
        ...ref,
        attempt: 2,
        worktree: { repo: 'acme/api', path: worktree, branch: 'foedrum/12-1/green/2', commit: tip },
      },
      {
        type: 'step.finished',
        ...ref,
        attempt: 2,
        outcome: { kind: 'succeeded', output: null },
        readings: [
          {
            result: 'exited',
            check: 'typecheck',
            command: 'npm run typecheck',
            exitCode: 0,
            tail: '',
          },
        ],
      },
    ];
    const batch = fold([...events, finished, ...later]).batches.get('12-1') ?? assert.fail();
    const text = renderStatus(batch);
    assert.ok(text.includes('The test map of acme/api is stale: '), text);
  });

  it("records a Brewery-kept map stale by a run alone as the Brewery's: regression test", async () => {
    const { run } = setup({ maps: fresh, keptIn: 'brewery', found: {} });
    const end = await run();
    assert.deepEqual(end.staleMap, {
      repo: 'acme/api',
      kept: 'brewery',
      paths: ['web/test-results.xml (no report of module "web")'],
      more: 0,
    });
  });

  it('names no module whose report path cannot be looked for after a passing run: regression test', async () => {
    // A TRX module's: the green check clears and reads a JUnit or TAP report path too (#727).
    const { run } = setup({
      maps: { [base]: mapOf(web, billing), [tip]: mapOf(web, billing) },
      refused: { 'svc/test/*/TestResults': 'svc/test/*/TestResults leads out of the worktree' },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(end.staleMap, undefined);
  });

  it('cuts a stale path to the 1,000 characters the event keeps: regression test', async () => {
    const long = `${'a'.repeat(1_100)}/App.csproj`;
    const { run } = setup({
      maps: fresh,
      manifests: { kind: 'stale', added: [long], removed: [] },
    });
    const end = await run();
    assert.deepEqual(end.staleMap?.paths, [long.slice(0, 1_000)]);
  });

  it('keeps the stale line past a later run whose tests failed, which judged no map', () => {
    const finished: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'succeeded', output: null },
      staleMap: { repo: 'acme/api', kept: 'repo', paths: named, more: 0 },
    };
    const failing: Event[] = [
      { type: 'step.scheduled', ...ref, attempt: 2, deadlineAt, retry: true },
      {
        type: 'step.started',
        ...ref,
        attempt: 2,
        worktree: { repo: 'acme/api', path: worktree, branch: 'foedrum/12-1/green/2', commit: tip },
      },
      {
        type: 'step.finished',
        ...ref,
        attempt: 2,
        outcome: { kind: 'failed', retryable: false, reason: 'tests failed' },
        readings: [{ result: 'exited', check: 'test', command: 'npm test', exitCode: 1, tail: '' }],
      },
    ];
    const batch = fold([...events, finished, ...failing]).batches.get('12-1') ?? assert.fail();
    const text = renderStatus(batch);
    assert.ok(text.includes('The test map of acme/api is stale: '), text);
  });

  it("keeps one repository's stale line when a run in another repository finds its own map fresh", () => {
    const finished: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'failed', retryable: false, reason: 'red' },
      staleMap: { repo: 'acme/api', kept: 'repo', paths: named, more: 0 },
    };
    const web = join('/work', 'acme.web', 'attempts', '12-1', 'green', '2');
    const elsewhere: Event[] = [
      { type: 'step.scheduled', ...ref, attempt: 2, deadlineAt, retry: true },
      {
        type: 'step.started',
        ...ref,
        attempt: 2,
        worktree: { repo: 'acme/web', path: web, branch: 'foedrum/12-1/green/2', commit: tip },
      },
      {
        type: 'step.finished',
        ...ref,
        attempt: 2,
        outcome: { kind: 'succeeded', output: null },
        readings: [{ result: 'exited', check: 'test', command: 'npm test', exitCode: 0, tail: '' }],
      },
    ];
    const batch = fold([...events, finished, ...elsewhere]).batches.get('12-1') ?? assert.fail();
    const text = renderStatus(batch);
    assert.ok(text.includes('The test map of acme/api is stale: '), text);
    assert.ok(!text.includes('acme/web is stale'), text);
  });
});
