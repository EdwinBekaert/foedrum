// The attempt plan's core (#148, ADR 0059): what the brewer of an attempt's step asks for, as the
// plan the claude runner takes (ADR 0047) and the limits the driver gives the attempt. Pure:
// attempt-plans.ts reads the state, the inputs and the files.

import type { AttemptRef } from '../engine/attempt-key.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { AttemptLimits } from '../engine/brewer-runner.ts';
import type { Batch } from '../engine/fold.ts';
import type { StepBrewer } from '../engine/recipe-files.ts';
import type { BrewerFrontmatter } from '../schemas/brewer.ts';
import type { ModelsConfig } from '../schemas/models.ts';
import type { ClaudeAttemptPlan } from './claude-runner.ts';
import type { InputSource, PromptInput, RandomBytes } from './prompt.ts';

/** Where the text of an input is read from: the order's issue, or a file inside `root`. */
export type InputRead =
  | { kind: 'order'; issue: number; repo?: string }
  | { kind: 'file'; path: string; root: string };

/** An input of the brewer, where it comes from, and where its text is read. */
export interface PlannedInput {
  name: string;
  source: InputSource;
  read: InputRead;
}

/** What one attempt's plan is made from. */
export interface PlanFacts {
  brewer: BrewerFrontmatter;
  /** The brewer file's body. */
  instructions: string;
  /** The attempt's worktree. */
  worktree: string;
  /** The brewer's inputs with their text, in its order. */
  inputs: readonly PromptInput[];
  models: ModelsConfig;
  /** The repository's toolchain rules (`foedrum.jsonc`, ADR 0023). */
  repoTools: readonly string[];
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  settingsFile: string;
  /** The id of the new session (ADR 0047). */
  sessionId: string;
  env: { base: Env; forced: Env; platform: NodeJS.Platform };
  random?: RandomBytes;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/** The limits the runner enforces for an attempt of `brewer`. */
export function attemptLimits(_brewer: BrewerFrontmatter): AttemptLimits {
  return notImplemented();
}

/** The model id behind the brewer's alias; throws when models.jsonc has none. */
export function modelOf(_models: ModelsConfig, _brewer: BrewerFrontmatter): string {
  return notImplemented();
}

/** The tool of each rule, once each, in the order first named. */
export function toolsOf(_rules: readonly string[]): string[] {
  return notImplemented();
}

/** Where each of `inputs` is read from; throws when a step it names has no out doc yet. */
export function inputsOf(
  _inputs: BrewerFrontmatter['inputs'],
  _batch: Batch,
  _stepBrewer: (stepId: string) => StepBrewer | undefined,
  _worktree: string,
): PlannedInput[] {
  return notImplemented();
}

/** The out doc contract every prompt ends its instructions with (brewers-and-recipes §2). */
export function outDocContract(_file: string): string {
  return notImplemented();
}

/** The attempt's settings file: `<workRoot>/attempt-settings/<batch>/<step>/<attempt>.json`. */
export function settingsFileOf(_workRoot: string, _ref: AttemptRef): string {
  return notImplemented();
}

/** The plan of one attempt; throws when its prompt cannot be assembled. */
export function planAttempt(_facts: PlanFacts): ClaudeAttemptPlan {
  return notImplemented();
}
