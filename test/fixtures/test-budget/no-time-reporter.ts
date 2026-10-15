// The budget reporter with a budget of 0 ms, so every test file is over it, for
// test/integration/test-budget-reporter.test.ts.
import { budgetReporter } from '../../../scripts/test-budget-reporter.ts';

export default budgetReporter({
  budgetMs: 0,
  cwd: process.cwd(),
  slowest: 5,
  fail: () => {
    process.exitCode = 1;
  },
});
