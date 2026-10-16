// node:test's spec reporter without the CPU time diagnostics that each test process sends for the
// budget reporter (scripts/test-cpu-time.ts, ADR 0035), which would add a line per test file.

import { compose } from 'node:stream';
import { spec } from 'node:test/reporters';
import { type TestEvent, withoutCpuTimes } from './test-budget-reporter.ts';

export default async function* (source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  yield* compose(withoutCpuTimes(source), new spec());
}
