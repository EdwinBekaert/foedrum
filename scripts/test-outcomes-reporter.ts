// A node:test reporter for the mutation check of /brew-review (issue #43): one JSON line per
// test that ran, with its file (relative to cwd, with /), its suites and name, and whether it
// passed. scripts/mutant-verdict.ts compares the lines of a run with a mutant to those of a run
// without it, so only a test the mutant makes fail kills it: not the per-file time budget, the
// coverage thresholds or a test that fails anyway, which all fail npm test.
//
// A file that fails to load is reported by the runner as a failed test named after the file.
// Suites, skipped and todo tests are left out.

import { relative, sep } from 'node:path';
import type { TestEvent } from './test-budget-reporter.ts';

export interface OutcomeEvent extends TestEvent {
  data?: TestEvent['data'] & {
    name?: string;
    skip?: boolean | string;
    todo?: boolean | string;
    details?: { type?: string };
  };
}

export const outcomesReporter = ({ cwd }: { cwd: string }) =>
  async function* (source: AsyncIterable<OutcomeEvent>): AsyncGenerator<string> {
    // Per file, the names of the tests and suites that started, by nesting level.
    const started = new Map<string, string[]>();
    for await (const { type, data } of source) {
      const { file, nesting = 0, name = '' } = data ?? {};
      if (file === undefined) continue;
      const names = started.get(file) ?? [];
      started.set(file, names);
      if (type === 'test:start') {
        names.length = nesting;
        names.push(name);
      } else if (type === 'test:pass' || type === 'test:fail') {
        if (data?.details?.type === 'suite' || data?.skip || data?.todo) continue;
        const test = [...names.slice(0, nesting), name];
        const path = relative(cwd, file).split(sep).join('/');
        yield `${JSON.stringify({ file: path, test, ok: type === 'test:pass' })}\n`;
      }
    }
  };

export default outcomesReporter({ cwd: process.cwd() });
