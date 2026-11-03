// Whether a mutant's test run killed it, from the test reports of the baseline and of the run with
// the mutant (ADR 0040, ADR 0313): only a test that fails because of the mutant kills it, a test of
// the mutant's module that passed at the baseline and fails or no longer reports, or a failure the
// baseline did not have. A test that fails in both runs does not. The review's own runs judge the
// same way (scripts/mutant-verdict/core.ts), from node's runner instead of the test map's reports.

import type { MappedReport } from './red-proof.ts';

/** What one mutant's run says, before a timeout or an invalid mutant is told apart. */
export type RunVerdict =
  | { kind: 'killed'; by: string }
  | { kind: 'survived' }
  | { kind: 'notJudged'; why: string };

interface Count {
  passed: number;
  failed: number;
}

/**
 * How many times each leaf test of `module` passed and failed, by name, in report order. A location
 * may be an absolute path, which differs between scratch trees, so tests that share a name are
 * counted together.
 */
const tally = (reports: readonly MappedReport[], module: string): Map<string, Count> => {
  const counts = new Map<string, Count>();
  for (const report of reports) {
    if (report.module !== module) continue;
    for (const test of report.tests) {
      if (!test.leaf) continue;
      const count = counts.get(test.name) ?? { passed: 0, failed: 0 };
      if (test.result === 'passed') count.passed += 1;
      if (test.result === 'failed') count.failed += 1;
      counts.set(test.name, count);
    }
  }
  return counts;
};

/** The verdict of a mutant of a file of `module`, from the baseline's reports and the run's. */
export const judgeRun = (
  baseline: readonly MappedReport[],
  run: readonly MappedReport[],
  module: string,
): RunVerdict => {
  const before = tally(baseline, module);
  if (![...before.values()].some(({ passed }) => passed > 0)) {
    return { kind: 'notJudged', why: `no test of module "${module}" passed at the baseline` };
  }
  if (!run.some((report) => report.module === module)) {
    return { kind: 'notJudged', why: `module "${module}" wrote no test report` };
  }
  const after = tally(run, module);
  // The first test of the run that fails more often, or passes less often, than at the baseline.
  for (const [name, { passed, failed }] of after) {
    const was = before.get(name);
    if (failed > (was?.failed ?? 0) || passed < (was?.passed ?? 0))
      return { kind: 'killed', by: name };
  }
  // Then a test that passed at the baseline and no longer reports: its file failed to load.
  for (const [name, { passed }] of before) {
    if (passed > 0 && !after.has(name)) return { kind: 'killed', by: name };
  }
  return { kind: 'survived' };
};
