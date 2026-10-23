// The brewer runner of `foedrum resume` on a running batch (ADR 0127): an attempt that resumes a
// session runs as the engineer's interactive `claude --resume` in the foreground, with the
// attempt's settings, guards and environment, and ends by the out doc the session wrote, through
// settleAttempt as every run does. An attempt that starts fresh runs headless, as its driver would.

import type { BrewerRunner } from '../engine/brewer-runner.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { CountCommits } from '../workspace/attempt-commits-git.ts';
import type { ClaudeAttemptPlan, ClaudeRunnerDeps, OutDocRead } from './claude-runner.ts';

export interface InteractiveRunnerDeps {
  /** The `claude` program to start. */
  claude: string;
  plan: ClaudeRunnerDeps['plan'];
  /** The headless runner of an attempt that starts fresh, with its plan. */
  headless: (
    plan: (attempt: Parameters<ClaudeRunnerDeps['plan']>[0]) => Promise<ClaudeAttemptPlan>,
  ) => BrewerRunner;
  /** Runs `program` in the foreground with the terminal's stdio; its exit code. */
  foreground: (
    program: string,
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<number>;
  /** The variables a terminal program reads to draw itself, which claude gets besides the brewer's. */
  terminalEnv: Readonly<Record<string, string>>;
  files: {
    writeSettings: (file: string, settings: AttemptSettings) => void;
    readOutDoc: (file: string, maxBytes: number, root: string) => OutDocRead;
    clearOutDoc: (file: string, root: string) => void;
  };
  commits: CountCommits;
  now: () => Date;
  /** Writes a line to the terminal, before claude has it. */
  say: (line: string) => void;
}

export function interactiveBrewerRunnerWith(_deps: InteractiveRunnerDeps): BrewerRunner {
  throw new Error('not implemented');
}
