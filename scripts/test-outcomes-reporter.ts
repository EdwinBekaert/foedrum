// A node:test reporter for the mutation check of /brew-review (issue #43): one JSON line per
// test that ran, with its file, its suites and name, and whether it passed.

import type { TestEvent } from './test-budget-reporter.ts';

export interface OutcomeEvent extends TestEvent {
  data?: TestEvent['data'] & {
    name?: string;
    skip?: boolean | string;
    todo?: boolean | string;
    details?: { type?: string };
  };
}

export const outcomesReporter = (_options: { cwd: string }) =>
  async function* (_source: AsyncIterable<OutcomeEvent>): AsyncGenerator<string> {
    yield* [];
    throw new Error('not implemented');
  };

export default outcomesReporter({ cwd: process.cwd() });
