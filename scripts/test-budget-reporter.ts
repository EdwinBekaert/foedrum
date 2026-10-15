// A node:test reporter that npm test runs next to spec: it adds up the top-level test times of
// each test file, prints the slowest files, and fails the run when one file goes over the budget.
// A slow file is a sign that a process or a real file system tree slipped into a unit test
// (ADR 0021). Tests within a file run one after another, so the sum is close to its wall time.

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

export const budgetReporter = (_options: BudgetOptions) =>
  // biome-ignore lint/correctness/useYield: a stub until the reporter is implemented
  async function* (_source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
    throw new Error('not implemented');
  };

export default budgetReporter({
  budgetMs: FILE_BUDGET_MS,
  cwd: process.cwd(),
  slowest: 5,
  fail: () => {
    process.exitCode = 1;
  },
});
