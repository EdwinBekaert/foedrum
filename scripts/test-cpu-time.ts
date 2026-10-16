// Loaded with --import by npm test, in the runner and in every test process it starts: each test
// process reports its CPU time for the budget reporter (scripts/test-budget-reporter.ts, ADR 0035).

import { after } from 'node:test';
import { recordCpuTime } from './test-budget-reporter.ts';

recordCpuTime({ env: process.env, after, cpuUsage: () => process.cpuUsage() });
