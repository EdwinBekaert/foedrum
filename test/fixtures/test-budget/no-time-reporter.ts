// The budget reporter with a budget of 0 ms for the files in this folder, so every test file here
// is over it, for test/integration/test-budget-reporter.test.ts.
import { budgetReporter } from '../../../scripts/test-budget-reporter.ts';

export default budgetReporter({
  budgetMs: 0,
  cwd: process.cwd(),
  budgetedDir: 'test/fixtures/test-budget/',
  slowest: 5,
  fail: () => {
    process.exitCode = 1;
  },
});
