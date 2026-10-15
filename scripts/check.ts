// `npm run check`: starts the typecheck, the linter, the tests and the two guards at once, prints
// each step's output in a fixed order, and fails when any step fails (issue #70).

import type { RunProcess } from './process-runner.ts';

export interface CheckStep {
  // How the step is shown, as the command a contributor would type.
  label: string;
  // Arguments for this node.
  args: string[];
}

export const checkSteps = (_npmCli: string): CheckStep[] => {
  throw new Error('not implemented');
};

export interface CheckOptions {
  env: NodeJS.ProcessEnv;
  execPath: string;
  runProcess: RunProcess;
  cwd: string;
  write: (text: string) => void;
}

// Resolves to the exit code.
export const runCheck = async (_options: CheckOptions): Promise<number> => {
  throw new Error('not implemented');
};
