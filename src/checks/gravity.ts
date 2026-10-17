// Gravity readings, the core (ADR 0021, ADR 0069): which command line each check of a check step
// runs on this platform, what one run read, and the step's outcome from its readings. Pure;
// check-runner.ts runs the commands.

import type { Ending } from '../engine/decide.ts';
import { findSecrets } from '../formats/secrets.ts';
import { type GravityReading, MAX_TAIL_LENGTH } from '../schemas/events.ts';
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
  /** The signal that ended it when the runner did not send it. */
  signal?: string;
}

/** The line `command` runs on `platform`: its override there, else `run`. */
export function commandLine(command: Command, platform: NodeJS.Platform): string {
  if (typeof command === 'string') return command;
  switch (platform) {
    case 'win32':
      return command.windows ?? command.run;
    case 'darwin':
      return command.macos ?? command.run;
    case 'linux':
      return command.linux ?? command.run;
    default:
      return command.run;
  }
}

/** The checks of a step, in order, as `repository` maps the named ones. */
export function planChecks(
  checks: readonly CheckRef[],
  repository: RepositoryChecks,
  platform: NodeJS.Platform,
): PlannedCheck[] {
  return checks.map((check): PlannedCheck => {
    if (typeof check !== 'string') return { kind: 'run', command: commandLine(check, platform) };
    const command = repository[check];
    return command === null
      ? { kind: 'skip', check }
      : { kind: 'run', check, command: commandLine(command, platform) };
  });
}

/** The end of `output` that a reading keeps (`MAX_TAIL_LENGTH`), never half a character. */
export function tailOf(output: string): string {
  if (output.length <= MAX_TAIL_LENGTH) return output;
  const tail = output.slice(-MAX_TAIL_LENGTH);
  // The second half of a surrogate pair whose first half was cut off.
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/**
 * `output` with each line that looks like a secret left out, saying what it looked like. A check
 * runs code a brewer may have written, so what it prints is untrusted (ADR 0069). A commit hash
 * counts too: the engine cannot tell one from a 40-character key.
 */
function withoutSecrets(output: string): string {
  // By line number; findSecrets splits the same lines, a CR going with its line.
  const found = new Map(findSecrets(output, () => false).map(({ line, kind }) => [line, kind]));
  if (found.size === 0) return output;
  return output
    .split('\n')
    .map((line, index) => {
      const kind = found.get(index + 1);
      return kind === undefined ? line : `[left out: a line that looks like a secret (${kind})]`;
    })
    .join('\n');
}

/** What one run of `check` read. */
export function readingOf(
  check: Extract<PlannedCheck, { kind: 'run' }>,
  run: CheckRun,
): GravityReading {
  const ran = {
    ...(check.check === undefined ? {} : { check: check.check }),
    command: check.command,
  };
  // Secrets out first, so the bound never keeps half of one.
  const tail = tailOf(withoutSecrets(run.output));
  if (run.killed !== undefined) return { result: 'killed', ...ran, killed: run.killed, tail };
  if (run.signal !== undefined) return { result: 'signaled', ...ran, signal: run.signal, tail };
  if (run.exitCode === null) return { result: 'unstarted', ...ran, tail };
  return { result: 'exited', ...ran, exitCode: run.exitCode, tail };
}

/** Whether a reading lets the step go on: a skip, or an exit with code 0. */
export function passed(reading: GravityReading): boolean {
  return reading.result === 'skipped' || (reading.result === 'exited' && reading.exitCode === 0);
}

/** A check as a reason names it: its name and command, or a literal command alone. */
const nameOf = ({ check, command }: { check?: CheckName | undefined; command: string }): string =>
  check === undefined ? `the check "${command}"` : `the check "${check}" (${command})`;

/** The last line of `text` that is not blank. */
const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);

/** The step's outcome from its readings: the first that did not pass decides (ADR 0069). */
export function settleReadings(readings: readonly GravityReading[]): Ending {
  const decisive = readings.find((reading) => !passed(reading));
  if (decisive === undefined) return { kind: 'succeeded', output: null };
  const environment = (summary: string): Ending => ({
    kind: 'blocked',
    blockerKind: 'environment',
    summary,
  });
  switch (decisive.result) {
    case 'skipped':
      throw new Error('A skipped check passes');
    // The same tree would read the same again: no retry, the onFail route or Stuck.
    case 'exited': {
      const reason = `${nameOf(decisive)} failed with exit code ${decisive.exitCode}`;
      return { kind: 'failed', retryable: false, reason };
    }
    // A crash of the code under check is a failure of the tree, as an exit code is.
    case 'signaled': {
      const reason = `${nameOf(decisive)} was ended by ${decisive.signal}`;
      return { kind: 'failed', retryable: false, reason };
    }
    case 'killed':
      switch (decisive.killed) {
        case 'stopped':
          return { kind: 'cancelled' };
        case 'timed-out': {
          const reason = `${nameOf(decisive)} did not finish by the step's deadline`;
          return { kind: 'failed', retryable: false, reason };
        }
        // Another attempt would write as much again; a human makes the check quieter.
        case 'too-much-output':
          return environment(
            `${nameOf(decisive)} wrote more output than the process runner's limit`,
          );
        default: {
          const unhandled: never = decisive.killed;
          throw new Error(`Unhandled kill ${JSON.stringify(unhandled)}`);
        }
      }
    // A missing shell or program: another attempt would meet the same environment.
    case 'unstarted': {
      const why = lastLine(decisive.tail);
      return environment(
        `${nameOf(decisive)} could not start${why === undefined ? '' : `: ${why}`}`,
      );
    }
    default: {
      const unhandled: never = decisive;
      throw new Error(`Unhandled reading ${JSON.stringify(unhandled)}`);
    }
  }
}
