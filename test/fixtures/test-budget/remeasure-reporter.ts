// The budget reporter with a budget of 0 ms for the files in this folder and npm test's re-measure,
// so every test file here is run again alone (ADR 0089), for
// test/integration/test-budget-reporter.test.ts.
import { budgetReporter, nodeRemeasure } from '../../../scripts/test-budget-reporter.ts';

export default budgetReporter({
  budgetMs: 0,
  cwd: process.cwd(),
  budgetedDir: 'test/fixtures/test-budget/',
  slowest: 5,
  fail: () => {
    process.exitCode = 1;
  },
  remeasure: nodeRemeasure(),
});
