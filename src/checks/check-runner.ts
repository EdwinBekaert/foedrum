// The check runner (ADR 0069): runs the attempts of check steps, the gravity readings. For an attempt
// the driver started, it runs the step's checks one after another in the attempt's worktree through
// the platform shell and the process runner, which kills the whole tree at the step's deadline or
// when the engine stops the attempt; the first check that does not pass ends the step. No model.

import type { BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { StepChecks } from '../engine/recipe-files.ts';
import type { ExecProcess } from '../platform/processes.ts';
import type { RepositoryChecks } from './gravity.ts';

export interface CheckRunnerOptions {
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** The checks of the recipes' check steps (`loadRecipes`). */
  checks: StepChecks;
  /** The commands of a repository's checks (`foedrum.jsonc`), or undefined when it lists none. */
  repositoryChecks: (repo: string) => RepositoryChecks | undefined;
  exec: ExecProcess;
  /** The environment the commands run in. */
  env: NodeJS.ProcessEnv;
  clock: () => Date;
  /** Default this process's. */
  platform?: NodeJS.Platform;
}

export function createCheckRunner(_options: CheckRunnerOptions): BrewerRunner {
  throw new Error('not implemented');
}
