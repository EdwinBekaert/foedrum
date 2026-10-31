// The uncovered-line check (ADR 0274): after a passing test reading in a repository with a test map,
// a changed line no test ran fails the check step, read from the spike's coverage reports and diffs
// (#680) and from small reports of its own, through an injected git, maps, report paths and
// process runner (ADR 0021).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import type { MapRead } from '../../src/checks/test-map.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import { parseCobertura } from '../../src/formats/cobertura.ts';
import {
  type CoverageFormat,
  mergeReports,
  type ReadCoverage,
} from '../../src/formats/coverage-report.ts';
import { parseLcov } from '../../src/formats/lcov.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { Event } from '../../src/schemas/events.ts';
import type { TestMap, TestMapModule } from '../../src/schemas/test-map.ts';
import type { Git } from '../../src/workspace/git.ts';

const worktree = join('/work', 'acme.api', 'attempts', '12-1', 'green', '1');
const clone = join('/work', 'acme.api', 'clone.git');
const ref = { batchId: '12-1', stepId: 'green', attempt: 1 };
const now = new Date('2026-10-31T12:00:00.000Z');
const deadlineAt = '2026-10-31T12:30:00.000Z';
const base = 'a'.repeat(40);
const tip = 'c'.repeat(40);

const spike = (...parts: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'coverage-spike', ...parts), 'utf8');

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

// The spike's TypeScript sample: one module, Node's LCOV.
const calc: TestMapModule = {
  name: 'calc',
  code: ['src/**'],
  tests: { paths: ['test/**'] },
  testReport: { format: 'tap', path: 'tap.txt' },
  coverage: { format: 'lcov', path: 'lcov.info' },
};
// The spike's C# sample: coverlet's Cobertura, a folder per test project.
const dotnet: TestMapModule = {
  name: 'dotnet',
  code: ['src/**'],
  tests: { projects: [{ path: 'test/Calc.Tests' }, { path: 'test/Text.Tests' }] },
  testReport: { format: 'junit', path: 'test/*/TestResults/junit.xml' },
  coverage: { format: 'cobertura', path: 'test/*/TestResults' },
};
const mapOf = (...modules: TestMapModule[]): MapRead => ({
  kind: 'map',
  map: { derivedFrom: { globs: ['**/package.json'], paths: [] }, modules } satisfies TestMap,
});

/** The LCOV report `text` as the reader gives it, its paths relative. */
const lcov = (text: string): ReadCoverage => parseLcov(text, worktree);
/** The spike's Cobertura reports of a step, merged as the folder reader merges them. */
const cobertura = (step: string): ReadCoverage => {
  const reports = ['Calc.Tests', 'Text.Tests'].map((project) => {
    const read = parseCobertura(spike('cs', step, `${project}.cobertura.xml`), 'C:\\spike\\cs');
    return read.readable ? read.report : assert.fail(read.reason);
  });
  return { readable: true, report: mergeReports(reports) };
};

const setup = ({
  maps = { [base]: mapOf(calc), [tip]: mapOf(calc) } as Record<string, MapRead>,
  diff = '',
  /** The coverage each module's path reads, by path. */
  coverage = {} as Record<string, ReadCoverage>,
  /** The report paths each pattern finds in the worktree. */
  found = {} as Record<string, string[]>,
  /** Why a pattern is refused, by pattern. */
  refused = {} as Record<string, string>,
  testExit = 0,
  started = events,
  /** git's last line of stderr when the diff fails. */
  diffFails = undefined as string | undefined,
  /** The files at the base, or git's last line of stderr when they cannot be listed. */
  atBase = [] as string[] | string,
  platform = 'linux' as NodeJS.Platform,
  /** Why clearing a report path throws, when it does. */
  clearFails = undefined as string | undefined,
  /** Why a pattern is refused once the test check ran, by pattern. */
  refusedAfterRun = {} as Record<string, string>,
  /** The checks of the step. */
  stepRefs = ['test'] as readonly ('test' | 'lint')[],
  /** The coverage a module's path reads in a root, when it depends on the root. */
  coverageIn = undefined as
    | ((format: CoverageFormat, path: string, root: string) => ReadCoverage)
    | undefined,
  /** The worktree's real path, as the check sandbox runs in it. */
  realPath = undefined as ((path: string) => string) | undefined,
} = {}) => {
  const asked: string[] = [];
  const exec: ExecProcess = (file) => {
    asked.push(`run ${file}`);
    const exitCode = file === 'npm test' ? testExit : file === 'npm run lint' ? 1 : 0;
    return Promise.resolve({ exitCode, stdout: '', stderr: '', output: '' });
  };
  const git: Git = async (cwd, args) => {
    assert.equal(cwd, clone);
    if (args.includes('diff')) {
      asked.push(`diff ${args.slice(-3, -1).join('..')}`);
      return diffFails === undefined
        ? { code: 0, stdout: diff, stderr: '' }
        : { code: 128, stdout: '', stderr: `fatal: ${diffFails}\n` };
    }
    if (args[0] === 'ls-tree' && args.includes(base)) {
      asked.push('files at the base');
      return typeof atBase === 'string'
        ? { code: 128, stdout: '', stderr: `fatal: ${atBase}\n` }
        : { code: 0, stdout: atBase.map((path) => `${path}\0`).join(''), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
  };
  const stepChecks: StepChecks = {
    find: (recipe, stepId) => (recipe === 'pale' && stepId === 'green' ? stepRefs : undefined),
    any: () => true,
    proves: () => undefined,
    redProof: () => undefined,
  };
  const runner = createCheckRunner({
    state: () => fold(started),
    checks: stepChecks,
    repositoryChecks: () => ({
      build: null,
      typecheck: null,
      lint: 'npm run lint',
      format: null,
      test: 'npm test',
    }),
    testReport: () => undefined,
    exec,
    git,
    clone: () => clone,
    reports: {
      clear: (file) => {
        asked.push(`clear ${file}`);
        if (clearFails !== undefined) throw new Error(clearFails);
      },
      read: () => ({ kind: 'missing' }),
    },
    env: { base: {}, forced: {} },
    clock: () => now,
    platform,
    testMap: {
      at: async (_repo, commit) => maps[commit] ?? { kind: 'none' },
      reports: (pattern) => {
        const why =
          refused[pattern] ??
          (asked.includes('run npm test') ? refusedAfterRun[pattern] : undefined);
        if (why !== undefined) return { refused: why };
        return { paths: found[pattern] ?? [join(worktree, ...pattern.split('/'))] };
      },
      coverage: (format: CoverageFormat, path: string, root: string) => {
        asked.push(`coverage ${format} ${path}`);
        if (coverageIn !== undefined) return coverageIn(format, path, root);
        return coverage[path] ?? { readable: false, reason: `no report at ${path}` };
      },
      ...(realPath === undefined ? {} : { realPath }),
    },
  });
  const run = () =>
    runner.start({ ref, limits: { outDoc: { file: 'out.md', schema: undefined as never } } }).ended;
  return { run, asked };
};

/** The reason of a failed ending, or a failure of the test. */
const reasonOf = (end: { ending: { kind: string; reason?: string } }): string =>
  end.ending.kind === 'failed' && end.ending.reason !== undefined
    ? end.ending.reason
    : assert.fail(JSON.stringify(end.ending));

/** A diff of `file` that adds `lines` lines from line `at`. */
const adding = (file: string, at: number, lines: number): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${at - 1},0 +${at},${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => `+line ${at + index}`),
    '',
  ].join('\n');

/** An LCOV record of `file` with the hits of each line. */
const record = (file: string, hits: Record<number, number>, branches = ''): string =>
  [
    `SF:${file}`,
    ...Object.entries(hits).map(([line, hit]) => `DA:${line},${hit}`),
    branches,
    'end_of_record',
  ].join('\n');

describe('createCheckRunner: the uncovered-line check (ADR 0274)', () => {
  it("fails the green check on the spike's untested RangeError guard", async () => {
    const { run } = setup({
      diff: spike('ts', '2-green', 'step.diff'),
      coverage: { 'lcov.info': lcov(spike('ts', '2-green', 'lcov.info')) },
    });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
    assert.equal(end.ending.kind === 'failed' && end.ending.retryable, false);
    assert.equal(
      reasonOf(end),
      '3 changed lines no test runs: src/calc.ts:12 (branch not taken), src/calc.ts:13, src/calc.ts:14',
    );
  });

  it("fails the green check on the spike's untested OverflowException guard", async () => {
    const { run } = setup({
      maps: { [base]: mapOf(dotnet), [tip]: mapOf(dotnet) },
      diff: spike('cs', '2-green', 'step.diff'),
      coverage: { 'test/*/TestResults': cobertura('2-green') },
    });
    const end = await run();
    assert.equal(
      reasonOf(end),
      '3 changed lines no test runs: src/Calc/Calculator.cs:19 (branch not taken), src/Calc/Calculator.cs:20, src/Calc/Calculator.cs:21',
    );
  });

  it('fails a Refactor that changes behaviour on a line no test runs (#645)', async () => {
    const { run } = setup({
      diff: spike('ts', '3-refactor', 'step.diff'),
      coverage: { 'lcov.info': lcov(spike('ts', '3-refactor', 'lcov.info')) },
    });
    const end = await run();
    assert.equal(reasonOf(end), '1 changed line no test runs: src/calc.ts:14');
  });

  it('fails a changed line whose branch data shows an untaken branch', async () => {
    const { run } = setup({
      diff: adding('src/clamp.ts', 7, 1),
      coverage: {
        'lcov.info': lcov(record('src/clamp.ts', { 7: 2 }, 'BRDA:7,0,0,2\nBRDA:7,0,1,0')),
      },
    });
    const end = await run();
    assert.equal(reasonOf(end), '1 changed line no test runs: src/clamp.ts:7 (branch not taken)');
  });

  it("passes a changed line that a test runs, in the union of two modules' reports", async () => {
    const web: TestMapModule = {
      ...calc,
      name: 'web',
      code: ['web/**'],
      tests: { paths: ['web-test/**'] },
      coverage: { format: 'lcov', path: 'web/lcov.info' },
    };
    const { run, asked } = setup({
      maps: { [base]: mapOf(calc, web), [tip]: mapOf(calc, web) },
      diff: adding('src/shared.ts', 3, 2),
      coverage: {
        // calc's tests run line 3, web's line 4, and neither both.
        'lcov.info': lcov(record('src/shared.ts', { 3: 1, 4: 0 })),
        'web/lcov.info': lcov(record('src/shared.ts', { 3: 0, 4: 5 })),
      },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.ok(asked.includes('coverage lcov lcov.info'), asked.join('\n'));
    assert.ok(asked.includes('coverage lcov web/lcov.info'), asked.join('\n'));
  });

  it('does not judge a types-only file Node never loaded, and lists it as not loaded by any test', async () => {
    const { run } = setup({
      diff: adding('src/types.ts', 1, 3),
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(end.coverage, { notLoaded: { files: ['src/types.ts'], more: 0 } });
  });

  it('fails a changed file that a Cobertura report lists at 0 hits', async () => {
    const { run } = setup({
      maps: { [base]: mapOf(dotnet), [tip]: mapOf(dotnet) },
      diff: spike('cs', '3-refactor', 'step.diff'),
      coverage: { 'test/*/TestResults': cobertura('3-refactor') },
    });
    const end = await run();
    assert.equal(
      reasonOf(end),
      '3 changed lines no test runs: src/Calc/Calculator.cs:22, src/Calc/Legacy.cs:8, src/Calc/Legacy.cs:9',
    );
  });

  it('fails a changed code file no Cobertura report holds, every changed line at 0 hits', async () => {
    const { run } = setup({
      maps: { [base]: mapOf(dotnet), [tip]: mapOf(dotnet) },
      diff: adding('src/Calc/Unloaded.cs', 4, 2),
      coverage: { 'test/*/TestResults': cobertura('3-refactor') },
    });
    const end = await run();
    assert.equal(
      reasonOf(end),
      '2 changed lines no test runs: src/Calc/Unloaded.cs:4, src/Calc/Unloaded.cs:5',
    );
  });

  it('lists a changed fixture outside every code area without failing', async () => {
    const { run } = setup({
      diff: adding('fixtures/rates.json', 1, 2),
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(end.coverage, { outside: { files: ['fixtures/rates.json'], more: 0 } });
  });

  it('skips a module marked coverage none and says so in the status comment', async () => {
    const legacy: TestMapModule = { ...calc, name: 'legacy', code: ['cfml/**'], coverage: 'none' };
    const { run, asked } = setup({
      maps: { [base]: mapOf(calc, legacy), [tip]: mapOf(calc, legacy) },
      // No report of calc either: reading one would fail the step.
      diff: adding('cfml/index.cfm', 1, 4),
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.ok(asked.includes('run npm test'), asked.join('|'));
    assert.ok(!asked.some((line) => line.startsWith('coverage')), asked.join('|'));
    assert.deepEqual(end.coverage, { unmeasured: ['legacy'] });
    const finished: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'succeeded', output: null },
      ...(end.coverage === undefined ? {} : { coverage: end.coverage }),
    };
    const batch = fold([...events, finished]).batches.get('12-1') ?? assert.fail();
    const text = renderStatus(batch, ['implement', 'green']);
    assert.match(text, /- ✅ `green`\n {2}- not measured, coverage none: legacy(\n|$)/);
  });

  it('names ten uncovered lines and counts the rest', async () => {
    const hits = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, 0]));
    const { run } = setup({
      diff: adding('src/many.ts', 1, 12),
      coverage: { 'lcov.info': lcov(record('src/many.ts', hits)) },
    });
    const end = await run();
    const named = Array.from({ length: 10 }, (_, index) => `src/many.ts:${index + 1}`);
    assert.equal(reasonOf(end), `12 changed lines no test runs: ${named.join(', ')} and 2 more`);
  });

  it('a coverage report left from an earlier run is removed before the test runs', async () => {
    const { run, asked } = setup({
      diff: adding('src/calc.ts', 1, 1),
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    await run();
    const cleared = asked.indexOf(`clear ${join(worktree, 'lcov.info')}`);
    assert.ok(cleared >= 0, asked.join('\n'));
    assert.ok(cleared < asked.indexOf('run npm test'), asked.join('\n'));
  });

  it('blocks the check step on its environment when a coverage report cannot be cleared', async () => {
    const { run, asked } = setup({
      diff: adding('src/calc.ts', 1, 1),
      refused: { 'lcov.info': 'lcov.info leads out of the worktree' },
    });
    const { ending } = await run();
    assert.deepEqual(ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'a coverage report of the test map cannot be cleared: lcov.info leads out of the worktree',
    });
    assert.ok(!asked.includes('run npm test'), asked.join('\n'));
  });

  it("blocks the check step on its environment when the batch's change cannot be read, keeping its readings", async () => {
    const { run } = setup({ diffFails: 'bad object' });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the change of the batch cannot be read: fatal: bad object',
    });
    assert.deepEqual(
      end.readings?.map((reading) => [reading.check, reading.result]),
      [['test', 'exited']],
    );
  });

  it("fails the check step along its onFail route when a module's coverage report cannot be read", async () => {
    const { run } = setup({ diff: adding('src/calc.ts', 1, 1) });
    const end = await run();
    assert.equal(
      reasonOf(end),
      'the coverage report of module "calc" cannot be read: no report at lcov.info',
    );
    assert.deepEqual(
      end.readings?.map((reading) => [reading.check, reading.result]),
      [['test', 'exited']],
    );
  });

  it('reads no coverage of a base module whose every file the batch deleted', async () => {
    const legacy: TestMapModule = {
      ...calc,
      name: 'legacy',
      code: ['legacy/**'],
      tests: { paths: ['legacy-test/**'] },
      coverage: { format: 'lcov', path: 'legacy/lcov.info' },
    };
    const gone = [
      'diff --git a/legacy/old.ts b/legacy/old.ts',
      'deleted file mode 100644',
      '--- a/legacy/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      '',
    ].join('\n');
    const { run, asked } = setup({
      maps: { [base]: mapOf(calc, legacy), [tip]: mapOf(calc, legacy) },
      diff: `${adding('src/calc.ts', 1, 1)}${gone}`,
      atBase: ['src/calc.ts', 'legacy/old.ts'],
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.ok(asked.includes('files at the base'), asked.join('\n'));
    assert.ok(!asked.includes('coverage lcov legacy/lcov.info'), asked.join('\n'));
  });

  it("blocks the check step on its environment when the base's files cannot be listed", async () => {
    const gone = [
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      '',
    ].join('\n');
    const { run } = setup({ diff: gone, atBase: 'not a tree' });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the files of ${base} cannot be read: fatal: not a tree`,
    });
  });

  it('finds a changed file in a report that names it in another case where the file system folds case', async () => {
    const { run } = setup({
      platform: 'win32',
      diff: adding('src/Calc.ts', 2, 1),
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 2: 0 })) },
    });
    const end = await run();
    assert.equal(reasonOf(end), '1 changed line no test runs: src/Calc.ts:2');
  });

  it("judges the change from where the batch starts to the step's tip: regression test", async () => {
    const { run, asked } = setup({
      diff: adding('src/calc.ts', 1, 1),
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    await run();
    assert.deepEqual(
      asked.filter((line) => line.startsWith('diff')),
      [`diff ${base}..${tip}`],
    );
  });

  it('judges the change from the base the batch merged (ADR 0164): regression test', async () => {
    const merged = 'e'.repeat(40);
    const key = effectKey.encode(
      baseMergeKey({ batchId: '12-1', stepId: 'implement', attempt: 1 }),
    );
    const { run, asked } = setup({
      started: [
        ...events,
        { type: 'effect.applied', key, result: { base: merged, merged: 'f'.repeat(40) } },
      ],
      maps: { [merged]: mapOf(calc), [tip]: mapOf(calc) },
      diff: adding('src/calc.ts', 1, 1),
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    await run();
    assert.deepEqual(
      asked.filter((line) => line.startsWith('diff')),
      [`diff ${merged}..${tip}`],
    );
  });

  it('lists ten files not loaded by any test and counts the rest: regression test', async () => {
    const files = Array.from({ length: 12 }, (_, index) => `src/t${index + 10}.ts`);
    const { run } = setup({
      diff: files.map((file) => adding(file, 1, 1)).join(''),
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(end.coverage, { notLoaded: { files: files.slice(0, 10), more: 2 } });
  });

  it('reads no coverage for a change only to a test area: regression test', async () => {
    const { run, asked } = setup({ diff: adding('test/calc.test.ts', 1, 3) });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.deepEqual(end.coverage, undefined);
    assert.ok(asked.includes('run npm test'), asked.join('|'));
    assert.ok(!asked.some((line) => line.startsWith('coverage')), asked.join('|'));
  });

  it('blocks the check step on its environment when a coverage report cannot be removed: regression test', async () => {
    const { run, asked } = setup({ diff: adding('src/calc.ts', 1, 1), clearFails: 'EBUSY' });
    const { ending } = await run();
    assert.deepEqual(ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'a coverage report of the test map cannot be cleared: lcov.info cannot be cleared: EBUSY',
    });
    assert.ok(asked.includes(`clear ${join(worktree, 'lcov.info')}`), asked.join('|'));
    assert.ok(!asked.includes('run npm test'), asked.join('|'));
  });

  it("shows the files not loaded and outside every code area under the check step's line: regression test", () => {
    const finished: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'succeeded', output: null },
      coverage: {
        notLoaded: { files: ['src/types.ts'], more: 2 },
        outside: { files: ['fixtures/rates.json'], more: 0 },
      },
    };
    const batch = fold([...events, finished]).batches.get('12-1') ?? assert.fail();
    const text = renderStatus(batch, ['implement', 'green']);
    assert.match(
      text,
      /- ✅ `green`\n {2}- not loaded by any test: src\/types\.ts and 2 more\n {2}- outside every code area: fixtures\/rates\.json(\n|$)/,
    );
  });

  it('records a listing of a long and a blank file name that step.finished admits', async () => {
    const long = `fixtures/${'a'.repeat(1200)}.json`;
    const { run } = setup({
      diff: `${adding(long, 1, 1)}${adding('   ', 1, 1)}`,
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    const listed = end.coverage?.outside?.files ?? [];
    assert.equal(listed.length, 2);
    assert.ok(
      listed.every((file) => file.length <= 1000 && /\S/.test(file)),
      listed.join('|'),
    );
    const finished = {
      type: 'step.finished',
      ...ref,
      outcome: end.ending,
      coverage: end.coverage,
    };
    assert.equal(Event.safeParse(finished).success, true);
  });

  it("blocks the check step on its environment when a module's coverage report path is refused after the run", async () => {
    const why = 'lcov.info leads out of the worktree';
    const { run } = setup({
      diff: adding('src/calc.ts', 1, 1),
      refusedAfterRun: { 'lcov.info': why },
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 1 })) },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the coverage report of module "calc" cannot be looked for: ${why}`,
    });
  });

  it("blocks the check step on its environment when a module's coverage report is past what is read", async () => {
    const reason = 'lcov.info: it is larger than 16777216 bytes';
    const { run } = setup({
      diff: adding('src/calc.ts', 1, 1),
      coverage: { 'lcov.info': { readable: false, reason, environment: true } },
    });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the coverage report of module "calc" cannot be read: ${reason}`,
    });
  });

  it("keeps a later check's failure as the step's ending", async () => {
    const { run } = setup({
      stepRefs: ['test', 'lint'],
      diff: adding('src/calc.ts', 1, 1),
      coverage: { 'lcov.info': lcov(record('src/calc.ts', { 1: 0 })) },
    });
    const end = await run();
    assert.equal(end.ending.kind, 'failed');
    assert.match(end.ending.kind === 'failed' ? end.ending.reason : '', /npm run lint/);
  });

  it('reads a coverage report that names the worktree by its real path, as the check sandbox runs it', async () => {
    const real = (path: string): string => `/private${path.replaceAll('\\', '/')}`;
    const { run } = setup({
      realPath: real,
      diff: adding('src/calc.ts', 1, 1),
      // The report names its files by the real path of the worktree, as a run started there does.
      coverageIn: (_format, _path, root) =>
        parseLcov(`SF:${real(worktree)}/src/calc.ts\nDA:1,0\nend_of_record\n`, root),
    });
    const end = await run();
    assert.equal(
      end.ending.kind === 'failed' ? end.ending.reason : JSON.stringify(end.ending),
      '1 changed line no test runs: src/calc.ts:1',
    );
  });

  it('a test reading in a repository with no test map passes as today: regression test', async () => {
    const { run, asked } = setup({ maps: {}, diff: adding('src/calc.ts', 1, 1) });
    const end = await run();
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
    assert.equal(end.coverage, undefined);
    assert.deepEqual(asked, ['run npm test']);
  });
});
