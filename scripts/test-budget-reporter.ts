// A node:test reporter that npm test runs next to spec: it adds up the top-level test times of
// each test file, prints the slowest files, and fails the run when one file goes over the budget.
// A slow file is a sign that a process or a real file system tree slipped into a unit test
// (ADR 0021). Tests within a file run one after another, so the sum is close to its wall time.

import { relative, sep } from 'node:path';

export const FILE_BUDGET_MS = 5000;

// The fields of node:test's reporter events that this reporter reads.
export interface TestEvent {
  type: string;
  data?: { nesting?: number; file?: string; details?: { duration_ms?: number } };
}

export interface BudgetOptions {
  budgetMs: number;
  // Files are printed relative to this directory.
  cwd: string;
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
      if (type !== 'test:pass' && type !== 'test:fail') continue;
      if (data?.nesting !== 0 || data.file === undefined) continue;
      times.set(data.file, (times.get(data.file) ?? 0) + (data.details?.duration_ms ?? 0));
    }
    if (times.size === 0) return;
    const files = [...times]
      .map(([file, ms]) => ({ file: relative(cwd, file).split(sep).join('/'), ms }))
      .sort((a, b) => b.ms - a.ms);
    yield `test file times (budget ${budgetMs / 1000} s per file, ADR 0021)\n`;
    for (const { file, ms } of files.slice(0, slowest)) yield `  ${seconds(ms)}  ${file}\n`;
    yield 'end of test file times\n';
    const over = files.filter(({ ms }) => ms > budgetMs);
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
