// The checks before a brewer's end, the core (ADR 0381): once a session of a brewer with
// `checksBeforeEnd` ends done with commits, the runner runs the repository's build, typecheck, lint
// and format, and the red step's tests where the test line takes files, and sends the first failure
// back to the same session once. Which lines run, the message, and what the two runs took together.
// Pure; claude-runner.ts runs them.

import type { RepositoryChecks } from '../checks/gravity.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { GravityReading, Receipt } from '../schemas/events.ts';
import type { CheckName } from '../schemas/primitives.ts';
import type { StreamFacts } from './claude-stream.ts';

/** A check of the repository as the checks before the end run it on this platform. */
export interface SendBackCheck {
  check: CheckName;
  command: string;
  /** Whether its line takes paths (`"files": true`). */
  files: boolean;
}

/** What the plan of an attempt with checks before its end holds (ADR 0381). */
export interface SendBackPlan {
  /** The repository's checks it has, in the order green runs them. */
  checks: readonly SendBackCheck[];
  /** The red step's test files, as the repository names them; none without a red step. */
  redTests: readonly string[];
  /** The attempt's deadline: each line is killed before it. */
  deadlineAt: string;
  /** The checks' environment, without claude's login (ADR 0069). */
  env: Env;
  /** Whether no sandbox holds the checks: on native Windows (ADR 0076). */
  unsandboxed: boolean;
}

/** A line the checks before the end run. */
export interface SendBackLine {
  check: CheckName;
  command: string;
}

/** The repository's checks the checks before the end can run, for `platform`. */
export function sendBackChecks(
  _repository: RepositoryChecks,
  _platform: NodeJS.Platform,
): SendBackCheck[] {
  throw new Error('not implemented');
}

/**
 * The lines to run: build and typecheck whole, lint and format on `changed` when their line takes
 * files, else whole, and the test line on the red step's test files only, when it takes files.
 */
export function sendBackLines(
  _checks: readonly SendBackCheck[],
  _changed: readonly string[] | undefined,
  _redTests: readonly string[],
): SendBackLine[] {
  throw new Error('not implemented');
}

/** The message that sends the brewer back: which check failed, and the end of what it printed. */
export function sendBackMessage(_reading: GravityReading): string {
  throw new Error('not implemented');
}

/** What a run and the run that resumed its session took together. */
export function afterSendBack(
  _first: { facts: StreamFacts; receipt: Receipt },
  _second: { facts: StreamFacts; receipt: Receipt },
): { facts: StreamFacts; receipt: Receipt } {
  throw new Error('not implemented');
}
