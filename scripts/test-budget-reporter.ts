// A node:test reporter that npm test runs next to spec: it reads how much CPU time each test file
// used, prints the files that used the most, and fails the run when one file goes over the
// budget. A costly file is a sign that real file system trees or too much work slipped into a unit
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
// The budget binds only files in test/unit/. Property and chaos files are costly by design:
// their run count sets their time. They get a ceiling instead, so only a run count grown too
// large fails them.

import { relative, sep } from 'node:path';

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
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

export const budgetReporter = ({
  budgetMs,
  cwd,
  budgetedDir = 'test/unit/',
  slowest,
  fail,
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
      .map(([file, wallMs]) => {
        const cpuMs = cpus.get(file);
        return {
          file: relative(cwd, file).split(sep).join('/'),
          wallMs,
          cpuMs,
          ms: cpuMs ?? wallMs,
          used:
            cpuMs === undefined
              ? `took ${seconds(wallMs)} of wall time (no CPU time reported)`
              : `used ${seconds(cpuMs)} of CPU time`,
        };
      })
      .sort((a, b) => b.ms - a.ms);
    yield `test file times (budget ${budgetMs / 1000} s of CPU time per file in ${budgetedDir}, ADR 0036)\n`;
    for (const { file, wallMs, cpuMs } of files.slice(0, slowest)) {
      const cpu = cpuMs === undefined ? 'no CPU time' : `${seconds(cpuMs)} CPU`;
      yield `  ${cpu}  ${seconds(wallMs)} wall  ${file}\n`;
    }
    yield 'end of test file times\n';
    let over = false;
    for (const { file, ms, used } of files) {
      if (file.startsWith(budgetedDir) && ms > budgetMs) {
        over = true;
        yield `✖ ${file} ${used}, over the ${budgetMs / 1000} s budget for one test file: make it cheaper, or move real tools and file system trees to test/integration/ (ADR 0021)\n`;
      } else if (CEILING_DIRS.some((dir) => file.startsWith(dir)) && ms > LAYER_CEILING_MS) {
        over = true;
        yield `✖ ${file} ${used}, over the ${LAYER_CEILING_MS / 1000} s ceiling for a property or chaos file: lower its run count (#87)\n`;
      }
    }
    if (over) fail();
  };

export default budgetReporter({
  budgetMs: FILE_BUDGET_MS,
  cwd: process.cwd(),
  slowest: 5,
  fail: () => {
    process.exitCode = 1;
  },
});
