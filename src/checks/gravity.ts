// Gravity readings, the core (ADR 0021, ADR 0069): which command line each check of a check step
// runs on this platform, what one run read, and the step's outcome from its readings. Pure;
// check-runner.ts runs the commands.

import type { Ending } from '../engine/decide.ts';
import type { GravityReading } from '../schemas/events.ts';
import type { CheckName, Command } from '../schemas/primitives.ts';
import type { CheckRef } from '../schemas/recipe.ts';

/** The command behind each check of a repository, or null where it has none (ADR 0023). */
export type RepositoryChecks = Readonly<Record<CheckName, Command | null>>;

/** A check ready to run: its command line on this platform, or a skip. */
export type PlannedCheck =
  | { kind: 'skip'; check: CheckName }
  /** `check` is absent for a Brewery's literal command. */
  | { kind: 'run'; check?: CheckName; command: string };

/** What the process runner answered for one command. */
export interface CheckRun {
  exitCode: number | null;
  output: string;
  killed?: 'timed-out' | 'stopped' | 'too-much-output';
}

/** The line `command` runs on `platform`: its override there, else `run`. */
export function commandLine(_command: Command, _platform: NodeJS.Platform): string {
  throw new Error('not implemented');
}

/** The checks of a step, in order, as `repository` maps the named ones. */
export function planChecks(
  _checks: readonly CheckRef[],
  _repository: RepositoryChecks,
  _platform: NodeJS.Platform,
): PlannedCheck[] {
  throw new Error('not implemented');
}

/** The end of `output` that a reading keeps (`MAX_TAIL_LENGTH`), never half a character. */
export function tailOf(_output: string): string {
  throw new Error('not implemented');
}

/** What one run of `check` read. */
export function readingOf(
  _check: Extract<PlannedCheck, { kind: 'run' }>,
  _run: CheckRun,
): GravityReading {
  throw new Error('not implemented');
}

/** Whether a reading lets the step go on: a skip, or an exit with code 0. */
export function passed(_reading: GravityReading): boolean {
  throw new Error('not implemented');
}

/** The step's outcome from its readings: the first that did not pass decides (ADR 0069). */
export function settleReadings(_readings: readonly GravityReading[]): Ending {
  throw new Error('not implemented');
}
