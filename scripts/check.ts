// `npm run check`: starts the typecheck, the linter, the tests and the two guards at once, prints
// each step's output in a fixed order with the failed steps last, and fails when any step fails. One after another they
// took about twice as long, mostly npm start-ups on Windows (issue #70). The tests are the test
// files the change reaches, without coverage; with --all, as in CI, every test file with
// coverage, as npm test (ADR 0241). The npm scripts run
// through npm's own CLI (npm_execpath, set by `npm run check`), so package.json stays the one
// place for their commands and nothing starts a shell.

import { parseArgs } from 'node:util';
import { stopOnSignals, whyKilled } from '../src/platform/processes.ts';
import type { Affected } from './affected-tests/core.ts';
import { lowerOwnPriority } from './below-normal-priority.ts';
import { outOfDate, type ReadText } from './deps-sync.ts';
import type { ProcessOutcome, RunProcess } from './process-runner.ts';

export interface CheckStep {
  // How the step is shown, as the command a contributor would type.
  label: string;
  // Arguments for this node.
  args: string[];
}

// Which tests the check runs: every test file with coverage, as npm test (--all), the test
// files a change reaches (ADR 0241), or none, at the push gate (--no-tests, ADR 0249).
export type TestRun = { kind: 'coverage' } | { kind: 'none' } | Affected;

// npm test's command without coverage and without its glob: the files go after it. A unit test
// holds package.json's test script to it.
export const TEST_COMMAND = [
  'scripts/with-checkout-tmp.ts',
  '--import',
  './scripts/test-cpu-time.ts',
  '--test',
  '--test-reporter=./scripts/spec-reporter.ts',
  '--test-reporter-destination=stdout',
  '--test-reporter=./scripts/test-budget-reporter.ts',
  '--test-reporter-destination=stdout',
];

// Every test file; node --test expands the glob itself.
export const TEST_GLOB = 'test/{unit,property,chaos}/**/*.test.ts';

const testStep = (npmCli: string, tests: TestRun): CheckStep[] => {
  switch (tests.kind) {
    case 'coverage':
      return [{ label: 'npm test', args: [npmCli, 'test'] }];
    case 'none':
      return [];
    case 'all':
      return [
        {
          label: 'node --test (every test file, without coverage)',
          args: [...TEST_COMMAND, TEST_GLOB],
        },
      ];
    case 'some': {
      const { files } = tests;
      if (files.length === 0) return [];
      const count = files.length === 1 ? '1 test file' : `${files.length} test files`;
      return [
        { label: `node --test (${count} the change reaches)`, args: [...TEST_COMMAND, ...files] },
      ];
    }
    default: {
      const never: never = tests;
      return never;
    }
  }
};

export const checkSteps = (npmCli: string, tests: TestRun = { kind: 'coverage' }): CheckStep[] => [
  { label: 'npm run typecheck', args: [npmCli, 'run', 'typecheck'] },
  { label: 'npm run lint', args: [npmCli, 'run', 'lint'] },
  ...testStep(npmCli, tests),
  { label: 'node scripts/check-test-layers.ts', args: ['scripts/check-test-layers.ts'] },
  { label: 'node scripts/check-deps.ts --offline', args: ['scripts/check-deps.ts', '--offline'] },
];

// The line that says which tests run, before the steps' output.
const testsLine = (tests: TestRun): string => {
  switch (tests.kind) {
    case 'coverage':
      return '';
    case 'none':
      return 'No tests run here: CI runs them (npm run check -- --all).\n';
    case 'all':
      return `Every test file runs, without coverage: ${tests.why}\n`;
    case 'some':
      return tests.files.length === 0
        ? 'No test file reached by the change.\n'
        : `Test files the change reaches (${tests.files.length}):\n${tests.files.map((file) => `  ${file}\n`).join('')}`;
    default: {
      const never: never = tests;
      return never;
    }
  }
};

// The test files the change reaches, or every test file when the change cannot be read.
const findTests = async (affected: (() => Promise<Affected>) | undefined): Promise<TestRun> => {
  if (affected === undefined) return { kind: 'coverage' };
  try {
    return await affected();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { kind: 'all', why: `the change could not be read: ${why}` };
  }
};

export interface CheckOptions {
  env: NodeJS.ProcessEnv;
  execPath: string;
  runProcess: RunProcess;
  cwd: string;
  // Reads the checkout's lock files, to tell whether node_modules is up to date; the real file
  // system by default.
  read?: ReadText;
  write: (text: string) => void;
  /** Each step's deadline. */
  stepTimeoutMs?: number;
  /** Stops the check: every step still running is killed with the processes it started. */
  signal?: AbortSignal;
  /**
   * Finds the test files the change reaches, which the check runs without coverage; without it
   * and without `noTests`, every test file runs with coverage, as npm test (`npm run check --
   * --all`, ADR 0241).
   */
  affected?: () => Promise<Affected>;
  /** Runs no tests, finding no change: the push gate's check (`npm run check -- --no-tests`, ADR 0249). */
  noTests?: boolean;
  /** Lowers this process's priority before the steps start, which inherit it (#140). */
  lowerPriority?: () => void;
}

// Each step's deadline: well under the local gate's 600 s, so a step that hangs fails here, named
// and with its output so far, instead of the gate giving up on the whole check.
const STEP_TIMEOUT_MS = 300_000;

/**
 * The check's options from its arguments: with --all, every test file with coverage, as CI runs
 * it; with --no-tests, no tests, as the push gate runs it (ADR 0249); with neither, the test
 * files the change reaches, found by `affected` (ADR 0241).
 */
export const checkMode = (
  argv: string[],
  affected: () => Promise<Affected>,
): Pick<CheckOptions, 'affected' | 'noTests'> => {
  const { all, 'no-tests': noTests } = parseArgs({
    args: argv,
    options: {
      all: { type: 'boolean', default: false },
      'no-tests': { type: 'boolean', default: false },
    },
  }).values;
  if (all && noTests) throw new Error('--all and --no-tests do not go together');
  if (noTests) return { noTests: true };
  return all ? {} : { affected };
};

const withNewline = (text: string): string =>
  text === '' || text.endsWith('\n') ? text : `${text}\n`;

// Resolves to the exit code.
export const runCheck = async ({
  env,
  execPath,
  runProcess,
  cwd,
  read,
  write,
  stepTimeoutMs = STEP_TIMEOUT_MS,
  signal,
  lowerPriority,
  affected,
  noTests = false,
}: CheckOptions): Promise<number> => {
  lowerPriority?.();
  // A worktree without node_modules of its own would run every step against the packages of the
  // checkout above it (#86): say so in the gate's line before starting anything.
  const stale = await outOfDate(cwd, read);
  if (stale !== undefined) {
    write(`node_modules is out of date with package-lock.json (${stale.reason}); run npm ci\n`);
    return 1;
  }
  const npmCli = env.npm_execpath;
  if (npmCli === undefined || npmCli === '') {
    write('npm_execpath is not set: run this as `npm run check`.\n');
    return 1;
  }
  const tests: TestRun = noTests ? { kind: 'none' } : await findTests(affected);
  write(testsLine(tests));
  // The runner kills a step's whole tree at the deadline or when the check is stopped. A runner
  // that rejects counts as a failed step, so the other steps are still waited for.
  const running = checkSteps(npmCli, tests).map(({ label, args }) => ({
    label,
    outcome: runProcess(execPath, args, cwd, { timeoutMs: stepTimeoutMs, signal }).catch(
      (error: unknown): ProcessOutcome => ({
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
      }),
    ),
  }));
  // Passing steps in step order, each as soon as it and the steps before it are done. Failed
  // steps come last, just before the summary: the local gate shows only the end of the output.
  const failed: { label: string; output: string }[] = [];
  for (const { label, outcome } of running) {
    const { exitCode, output, killed } = await outcome;
    const why = whyKilled(killed, stepTimeoutMs);
    const text = `> ${label}\n${withNewline(output)}${why === undefined ? '' : `${why}\n`}`;
    if (exitCode === 0) write(text);
    else failed.push({ label: why === undefined ? label : `${label} (${why})`, output: text });
  }
  if (failed.length === 0) return 0;
  for (const { output } of failed) write(output);
  write(`✖ npm run check failed: ${failed.map(({ label }) => label).join(', ')}\n`);
  return 1;
};

if (import.meta.main) {
  const { spawnProcess } = await import('./process-runner.ts');
  const { affectedInCheckout } = await import('./affected-tests.ts');
  const cwd = process.cwd();
  // Outside Windows the steps lead process groups of their own, which a Ctrl+C in the terminal
  // does not reach, and on Windows npm's children would outlive it: kill their trees instead.
  // The gate stops the check with SIGTERM before SIGKILL (killProcessTree), so this process
  // kills the steps' trees. Only a SIGKILL without that warning leaves them running.
  process.exitCode = await runCheck({
    env: process.env,
    execPath: process.execPath,
    runProcess: spawnProcess,
    cwd,
    write: (text) => process.stdout.write(text),
    signal: stopOnSignals(),
    // Below normal outside CI, so the steps leave the desktop responsive (#140).
    lowerPriority: () => lowerOwnPriority(process.env),
    ...checkMode(process.argv.slice(2), () => affectedInCheckout(cwd)),
  });
}
