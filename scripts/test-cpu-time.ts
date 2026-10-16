// Loaded with --import by npm test, in the runner and in every test process it starts: each test
// process reports its CPU time for the budget reporter (scripts/test-budget-reporter.ts, ADR 0036)
// and refuses to start processes (scripts/refuse-process-starts.ts, ADR 0021).

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { after } from 'node:test';
import { refuseProcessStarts } from './refuse-process-starts.ts';
import { recordCpuTime } from './test-budget-reporter.ts';

recordCpuTime({ env: process.env, after, cpuUsage: () => process.cpuUsage() });
refuseProcessStarts({
  env: process.env,
  // The module object itself, as require() returns it; an import gives only its ES module wrapper.
  childProcess: createRequire(import.meta.url)('node:child_process'),
  syncBuiltinESMExports,
  after,
});
