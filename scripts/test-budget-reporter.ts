// A node:test reporter that npm test runs next to spec: it reads the time of each test file from
// the runner's per-file summary, prints the slowest files, and fails the run when one file goes
// over the budget. A slow file is a sign that a process or a real file system tree slipped into a
// unit test (ADR 0021). The summary covers the file's tests and hooks, not the time it takes to
// load the module; the test-layer guard (scripts/check-test-layers.ts) covers direct imports.
//
// The budget is wall time, the only time node:test reports per file, and it binds only files in
// test/unit/. Property and chaos files are slow by design: their run count sets their time, and
// under a parallel `npm run check` it grows with the machine's load (#87). They are listed, but
// never fail the run.

import { relative, sep } from 'node:path';

export const FILE_BUDGET_MS = 5000;

// The folder, relative to cwd, whose files are held to the budget.
const BUDGETED = 'test/unit/';

// The fields of node:test's reporter events that this reporter reads.
export interface TestEvent {
  type: string;
  data?: { nesting?: number; file?: string; duration_ms?: number };
}

export interface BudgetOptions {
  budgetMs: number;
  // Files are printed relative to this directory.
  cwd: string;
  // The folder, relative to cwd and ending in '/', whose files are held to the budget; test/unit/
  // by default.
  budgetedDir?: string;
  // How many of the slowest files to list.
  slowest: number;
  // Marks the run as failed.
  fail: () => void;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

export const budgetReporter = ({ budgetMs, cwd, slowest, fail }: BudgetOptions) =>
  async function* (source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
    const times = new Map<string, number>();
    for await (const { type, data } of source) {
      // The summary of the whole run has no file.
      if (type !== 'test:summary' || data?.file === undefined) continue;
      times.set(data.file, data.duration_ms ?? 0);
    }
    if (times.size === 0) return;
    const files = [...times]
      .map(([file, ms]) => ({ file: relative(cwd, file).split(sep).join('/'), ms }))
      .sort((a, b) => b.ms - a.ms);
    yield `test file times (budget ${budgetMs / 1000} s per file in ${BUDGETED}, ADR 0021)\n`;
    for (const { file, ms } of files.slice(0, slowest)) yield `  ${seconds(ms)}  ${file}\n`;
    yield 'end of test file times\n';
    const over = files.filter(({ file, ms }) => file.startsWith(BUDGETED) && ms > budgetMs);
    for (const { file, ms } of over) {
      yield `✖ ${file} took ${seconds(ms)}, over the ${budgetMs / 1000} s budget for one test file: move processes and real tools to test/integration/ (ADR 0021)\n`;
    }
    if (over.length > 0) fail();
  };

export default budgetReporter({
  budgetMs: FILE_BUDGET_MS,
  cwd: process.cwd(),
  slowest: 5,
  fail: () => {
    process.exitCode = 1;
  },
});
