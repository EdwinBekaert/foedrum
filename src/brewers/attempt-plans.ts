// The attempt plans' shell (#148, ADR 0059): for an attempt the driver started, it finds the brewer
// of its step in the batch's recipe, reads the brewer's inputs and makes the settings file's
// folder, then plans the attempt through attempt-plan.ts, which decides.

import type { AttemptRef } from '../engine/attempt-key.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { AttemptLimits, AttemptStart } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { StepBrewers } from '../engine/recipe-files.ts';
import type { ModelsConfig } from '../schemas/models.ts';
import type { InputRead } from './attempt-plan.ts';
import type { ClaudeAttemptPlan, OutDocRead } from './claude-runner.ts';
import type { RandomBytes } from './prompt.ts';

export interface AttemptPlansOptions {
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** The brewers of the recipes' steps (`loadRecipes`). */
  brewers: StepBrewers;
  models: ModelsConfig;
  /** The toolchain rules of a repository (`foedrum.jsonc`, ADR 0023). */
  repoTools: (repo: string) => readonly string[];
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  /** The Brewery's work root (ADR 0037). */
  workRoot: string;
  /** The brewer's minimal base environment and the runner's forced variables (ADR 0028). */
  env: { base: Env; forced: Env };
  /** Default this process's. */
  platform?: NodeJS.Platform;
  /** The text of an order's issue, untrusted. */
  orderText: (order: Extract<InputRead, { kind: 'order' }>) => Promise<string>;
  /** Default the file system's: `readOutDocFile` and a recursive `mkdir`. */
  files?: {
    read: (file: string, maxBytes: number, root: string) => OutDocRead;
    makeFolder: (path: string) => void;
  };
  /** Default `randomUUID`. */
  sessionId?: () => string;
  random?: RandomBytes;
}

export interface AttemptPlans {
  /** The plan of an attempt the driver started; rejects when it cannot be made. */
  plan(attempt: AttemptStart): Promise<ClaudeAttemptPlan>;
  /** The limits of an attempt, from the brewer of its step in its batch's recipe. */
  limits(ref: AttemptRef): AttemptLimits;
}

export function createAttemptPlans(_options: AttemptPlansOptions): AttemptPlans {
  throw new Error('not implemented');
}
