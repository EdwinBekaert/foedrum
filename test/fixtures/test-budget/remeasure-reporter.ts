// npm test's budget reporter, re-measure included, with a budget of 0 ms for the files in this
// folder, so every test file here is run again alone (ADR 0089), for
// test/integration/test-budget-reporter.test.ts.
import { npmTestReporter } from '../../../scripts/test-budget-reporter.ts';

export default npmTestReporter({ budgetMs: 0, budgetedDir: 'test/fixtures/test-budget/' });
