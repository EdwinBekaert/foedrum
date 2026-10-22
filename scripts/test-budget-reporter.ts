// A node:test reporter that npm test runs next to spec: it reads how much CPU time each test file
// used, prints the files that used the most, and, in CI, fails the run when one file goes over
// the budget (ADR 0136). A costly file is a sign that real file system trees or too much work slipped into a unit
// test (ADR 0021); the test-layer guard (scripts/check-test-layers.ts) and the preload's refusal
// (scripts/refuse-process-starts.ts, ADR 0038) cover processes.
//
// The budget is CPU time, not wall time (ADR 0036): parallel steps of `npm run check` and other
// sessions on the same machine stretch a file's wall time, so a wall-time budget failed pushes
// at random (#87, #108). node:test reports only wall time per file, so each test process reports
// its own CPU time (user and system, from process.cpuUsage) as a diagnostic from an after hook:
// scripts/test-cpu-time.ts, which npm test loads with --import, calls recordCpuTime, and
// scripts/spec-reporter.ts keeps those diagnostics out of spec's output. The reading covers
// loading the file and its tests and hooks, but not the file's own root-level after hooks, which
// run after it. A file without a reading (it failed to load, or the run left out the preload) is
// held to its wall time, which the runner always reports.
//
// CPU time still grows with load: on a hybrid or hyper-threaded CPU the same work takes several
// times the CPU time while other processes keep the cores busy (#248). So a file over the budget
// or the ceiling in the run is run again alone, one at a time, once the run has ended and its own
// files no longer load the machine, up to three times, and the lowest reading counts (ADR 0089).
// That fails only in CI, where the machine is not shared: outside it (CI unset or empty) other
// sessions' load can outlast every run alone, so a file over the budget or the ceiling is listed
// in the times, fails nothing and is not run alone (ADR 0136).
//
// The budget binds only files in test/unit/. Property and chaos files are costly by design:
// their run count sets their time. They get a ceiling instead, so only a run count grown too
// large fails them.

import { relative, sep } from 'node:path';
import type { RunProcess } from './process-runner.ts';

export const FILE_BUDGET_MS = 5000;

export const LAYER_CEILING_MS = 15_000;

// The folders, relative to cwd, whose files are held to the ceiling.
const CEILING_DIRS = ['test/property/', 'test/chaos/'];

// The fields of node:test's reporter events that this reporter reads.
export interface TestEvent {
  type: string;
  data?: { nesting?: number; file?: string; duration_ms?: number; message?: string };
}

// What recordCpuTime needs from node:test and the process; injected, so tests pass fakes.
export interface CpuTimeOptions {
  env: NodeJS.ProcessEnv;
  // node:test's after: registers a hook that runs after the file's tests.
  after: (hook: (context: { diagnostic: (message: string) => void }) => void) => void;
  // process.cpuUsage: this process's user and system time so far, in µs.
  cpuUsage: () => { user: number; system: number };
}

const CPU_TIME = 'foedrum test file CPU time ms: ';

// In a test process the runner started (it sets NODE_TEST_CONTEXT), reports the process's CPU
// time after the file's tests. With --import node loads the preload in the runner as well,
// which runs no tests of its own.
export const recordCpuTime = ({ env, after, cpuUsage }: CpuTimeOptions): void => {
  if (env.NODE_TEST_CONTEXT === undefined) return;
  after((context) => {
    const { user, system } = cpuUsage();
    context.diagnostic(`${CPU_TIME}${(user + system) / 1000}`);
  });
};

// The CPU time in a test file's diagnostic from recordCpuTime, in ms.
const cpuTimeOf = ({ type, data }: TestEvent): number | undefined => {
  if (type !== 'test:diagnostic' || data?.file === undefined) return undefined;
  if (data.message?.startsWith(CPU_TIME) !== true) return undefined;
  const ms = Number(data.message.slice(CPU_TIME.length));
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

// The events without the CPU time diagnostics, for spec.
export async function* withoutCpuTimes(source: AsyncIterable<TestEvent>): AsyncIterable<TestEvent> {
  for await (const event of source) if (cpuTimeOf(event) === undefined) yield event;
}

export interface BudgetOptions {
  budgetMs: number;
  // Files are printed relative to this directory.
  cwd: string;
  // The folder, relative to cwd and ending in '/', whose files are held to the budget; test/unit/
  // by default.
  budgetedDir?: string;
  // How many of the costliest files to list.
  slowest: number;
  // Marks the run as failed.
  fail: () => void;
  // Measures a file's CPU time again, alone, once the run has ended, in ms; undefined when that
  // run reported none (ADR 0089). Without it, the run's reading is the only one.
  remeasure?: (file: string) => Promise<number | undefined>;
  // For how long after the first run alone another may start, in ms of `now`; one started just
  // before may still take its deadline.
  remeasureForMs?: number;
  // The time in ms; performance.now by default.
  now?: () => number;
  // Whether the run is in CI (runsInCi); outside it, a file over its limit is listed in the times
  // and fails nothing, and is not run alone (ADR 0136). True by default.
  ci?: boolean;
}

// Whether npm test runs in CI: CI set and not empty, as scripts/below-normal-priority.ts reads it.
export const runsInCi = (env: NodeJS.ProcessEnv): boolean => env.CI !== undefined && env.CI !== '';

// One file's run alone gets a minute: a unit file within the budget takes a few seconds.
const REMEASURE_TIMEOUT_MS = 60_000;

// How many times a file over the budget or the ceiling is run alone, at most.
const REMEASURES = 3;

// For how long runs alone may start: with one more that takes its 60 s and npm test's own run,
// they stay within the check step's 300 s (scripts/check.ts).
const REMEASURE_FOR_MS = 90_000;

export interface RemeasureOptions {
  // The node that runs the file, and the folder it runs in.
  execPath: string;
  cwd: string;
  runProcess: RunProcess;
  // The deadline of one file's run.
  timeoutMs?: number;
}

// Runs one test file alone under node --test with the CPU time preload, as npm test does, and
// reads the CPU time it reports (ADR 0089).
export const remeasureAlone =
  ({ execPath, cwd, runProcess, timeoutMs = REMEASURE_TIMEOUT_MS }: RemeasureOptions) =>
  async (file: string): Promise<number | undefined> => {
    const { output, killed } = await runProcess(
      execPath,
      [
        '--import',
        './scripts/test-cpu-time.ts',
        '--test',
        '--experimental-test-coverage',
        '--test-reporter=tap',
        '--test-reporter-destination=stdout',
        file,
      ],
      cwd,
      { timeoutMs },
    );
    if (killed !== undefined) return undefined;
    // TAP prints each diagnostic as a comment; the highest reading, as in the run.
    const readings = output
      .split('\n')
      .filter((line) => line.includes(CPU_TIME))
      .map((line) => Number(line.slice(line.indexOf(CPU_TIME) + CPU_TIME.length).trim()))
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    return readings.length === 0 ? undefined : Math.max(...readings);
  };

// The real re-measure: this node, in the folder npm test runs in, through the process runner,
// loaded only when a file is over, since every test process loads this module (ADR 0038).
export const nodeRemeasure = (): ((file: string) => Promise<number | undefined>) =>
  remeasureAlone({
    execPath: process.execPath,
    cwd: process.cwd(),
    runProcess: async (...args) => (await import('./process-runner.ts')).spawnProcess(...args),
  });

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

export const budgetReporter = ({
  budgetMs,
  cwd,
  budgetedDir = 'test/unit/',
  slowest,
  fail,
  remeasure,
  remeasureForMs = REMEASURE_FOR_MS,
  now = () => performance.now(),
  ci = true,
}: BudgetOptions) =>
  async function* (source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
    const walls = new Map<string, number>();
    const cpus = new Map<string, number>();
    for await (const event of source) {
      const cpuMs = cpuTimeOf(event);
      const file = event.data?.file;
      // The highest reading: a file's own after hook could send a lower one after the real one.
      if (cpuMs !== undefined && file !== undefined)
        cpus.set(file, Math.max(cpuMs, cpus.get(file) ?? 0));
      // The summary of the whole run has no file.
      else if (event.type === 'test:summary' && file !== undefined)
        walls.set(file, event.data?.duration_ms ?? 0);
    }
    if (walls.size === 0) return;
    // A file is measured by its CPU time, or by its wall time when it reported none.
    const files = [...walls]
      .map(([path, wallMs]) => {
        const cpuMs = cpus.get(path);
        return {
          path,
          file: relative(cwd, path).split(sep).join('/'),
          wallMs,
          cpuMs,
          ms: cpuMs ?? wallMs,
        };
      })
      .sort((a, b) => b.ms - a.ms);
    // The limit a file is held to, if any.
    const limitOf = (file: string) =>
      file.startsWith(budgetedDir)
        ? {
            ms: budgetMs,
            name: 'budget',
            advice: `for one test file: make it cheaper, or move real tools and file system trees to test/integration/ (ADR 0021)`,
          }
        : CEILING_DIRS.some((dir) => file.startsWith(dir))
          ? {
              ms: LAYER_CEILING_MS,
              name: 'ceiling',
              advice: 'for a property or chaos file: lower its run count (#87)',
            }
          : undefined;
    const overLimit = files.flatMap((entry) => {
      const limit = limitOf(entry.file);
      return limit === undefined || entry.ms <= limit.ms ? [] : [{ ...entry, limit }];
    });
    const usedIn = (wallMs: number, cpuMs: number | undefined) =>
      cpuMs === undefined
        ? `took ${seconds(wallMs)} of wall time (no CPU time reported)`
        : `used ${seconds(cpuMs)} of CPU time`;
    yield `test file times (budget ${budgetMs / 1000} s of CPU time per file in ${budgetedDir}, ADR 0036)\n`;
    for (const { file, wallMs, cpuMs } of files.slice(0, slowest)) {
      const cpu = cpuMs === undefined ? 'no CPU time' : `${seconds(cpuMs)} CPU`;
      yield `  ${cpu}  ${seconds(wallMs)} wall  ${file}\n`;
    }
    // Outside CI, other sessions' load can push a file over with nothing wrong in it (ADR 0136).
    if (!ci)
      for (const { file, wallMs, cpuMs, limit } of overLimit)
        yield `  ⚠ ${file} ${usedIn(wallMs, cpuMs)}, over the ${limit.ms / 1000} s ${limit.name} ${limit.advice}; it fails only in CI (ADR 0136)\n`;
    yield 'end of test file times\n';
    if (!ci) return;
    let over = false;
    // When the first run alone started.
    let remeasuresFrom: number | undefined;
    for (const { path, file, wallMs, cpuMs, limit } of overLimit) {
      const overThe = `over the ${limit.ms / 1000} s ${limit.name}`;
      let used = usedIn(wallMs, cpuMs);
      // Load only adds CPU time, so the lowest reading is the closest one (ADR 0089). One file at
      // a time, once the run has ended, so they do not load each other; up to three runs, since
      // other sessions' load can outlast the run.
      let aloneMs: number | undefined;
      let outOfTime = false;
      for (let run = 0; cpuMs !== undefined && remeasure !== undefined && run < REMEASURES; run++) {
        remeasuresFrom ??= now();
        outOfTime = now() - remeasuresFrom >= remeasureForMs;
        if (outOfTime) break;
        const reading = await remeasure(path);
        if (reading !== undefined) aloneMs = Math.min(reading, aloneMs ?? reading);
        if (aloneMs === undefined || aloneMs <= limit.ms) break;
      }
      if (cpuMs !== undefined && aloneMs !== undefined) {
        if (aloneMs <= limit.ms) {
          yield `ℹ ${file} used ${seconds(cpuMs)} of CPU time in the run, ${overThe}, and ${seconds(aloneMs)} alone: the same work takes more CPU time on a loaded machine (ADR 0089)\n`;
          continue;
        }
        used =
          aloneMs <= cpuMs
            ? `used ${seconds(aloneMs)} of CPU time alone (${seconds(cpuMs)} in the run)`
            : `used ${seconds(cpuMs)} of CPU time in the run (${seconds(aloneMs)} alone)`;
      } else if (outOfTime) {
        used += `, not run alone: the runs alone took their ${remeasureForMs / 1000} s (ADR 0089)`;
      }
      over = true;
      yield `✖ ${file} ${used}, ${overThe} ${limit.advice}\n`;
    }
    if (over) fail();
  };

// npm test's reporter, with the given options changed (the integration tests lower the budget),
// in CI or not by the given environment.
export const npmTestReporter = (
  overrides: Partial<BudgetOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
) =>
  budgetReporter({
    budgetMs: FILE_BUDGET_MS,
    cwd: process.cwd(),
    slowest: 5,
    fail: () => {
      process.exitCode = 1;
    },
    remeasure: nodeRemeasure(),
    ci: runsInCi(env),
    ...overrides,
  });

export default npmTestReporter();
