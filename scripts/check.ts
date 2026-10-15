// `npm run check`: starts the typecheck, the linter, the tests and the two guards at once, prints
// each step's output in a fixed order with the failed steps last, and fails when any step fails. One after another they
// took about twice as long, mostly npm start-ups on Windows (issue #70). The npm scripts run
// through npm's own CLI (npm_execpath, set by `npm run check`), so package.json stays the one
// place for their commands and nothing starts a shell.

import type { ProcessOutcome, RunProcess } from './process-runner.ts';

export interface CheckStep {
  // How the step is shown, as the command a contributor would type.
  label: string;
  // Arguments for this node.
  args: string[];
}

export const checkSteps = (npmCli: string): CheckStep[] => [
  { label: 'npm run typecheck', args: [npmCli, 'run', 'typecheck'] },
  { label: 'npm run lint', args: [npmCli, 'run', 'lint'] },
  { label: 'npm test', args: [npmCli, 'test'] },
  { label: 'node scripts/check-test-layers.ts', args: ['scripts/check-test-layers.ts'] },
  { label: 'node scripts/check-deps.ts --offline', args: ['scripts/check-deps.ts', '--offline'] },
];

export interface CheckOptions {
  env: NodeJS.ProcessEnv;
  execPath: string;
  runProcess: RunProcess;
  cwd: string;
  write: (text: string) => void;
  /** Each step's deadline. */
  stepTimeoutMs?: number;
  /** Stops the check: every step still running is killed with the processes it started. */
  signal?: AbortSignal;
}

const withNewline = (text: string): string =>
  text === '' || text.endsWith('\n') ? text : `${text}\n`;

// Resolves to the exit code.
export const runCheck = async ({
  env,
  execPath,
  runProcess,
  cwd,
  write,
}: CheckOptions): Promise<number> => {
  const npmCli = env.npm_execpath;
  if (npmCli === undefined || npmCli === '') {
    write('npm_execpath is not set: run this as `npm run check`.\n');
    return 1;
  }
  // A runner that rejects counts as a failed step, so the other steps are still waited for.
  const running = checkSteps(npmCli).map(({ label, args }) => ({
    label,
    outcome: runProcess(execPath, args, cwd).catch(
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
    const { exitCode, output } = await outcome;
    const text = `> ${label}\n${withNewline(output)}`;
    if (exitCode === 0) write(text);
    else failed.push({ label, output: text });
  }
  if (failed.length === 0) return 0;
  for (const { output } of failed) write(output);
  write(`✖ npm run check failed: ${failed.map(({ label }) => label).join(', ')}\n`);
  return 1;
};

if (import.meta.main) {
  const { spawnProcess } = await import('./process-runner.ts');
  process.exitCode = await runCheck({
    env: process.env,
    execPath: process.execPath,
    runProcess: spawnProcess,
    cwd: process.cwd(),
    write: (text) => process.stdout.write(text),
  });
}
