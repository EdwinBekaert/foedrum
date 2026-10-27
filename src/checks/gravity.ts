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
  /** `check` is absent for a Brewery's literal command and a repository's setup (ADR 0140). */
  | { kind: 'run'; check?: CheckName; setup?: true; command: string };

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
 * `output` with each line that can reach the tail left out when it looks like a secret, saying
 * what it looked like. A check runs code a brewer may have written, so what it prints is untrusted
 * (ADR 0069). A commit hash counts too: the engine cannot tell one from a 40-character key. Only
 * the lines the tail can keep are read, from the end, and of a long line only its end, so output
 * written to stall the patterns costs no more than a tail's worth.
 */
export function withoutSecrets(output: string): string {
  const lines = output.split('\n');
  // Counted as kept once left out, so the tail never reaches a line that was not read.
  let kept = 0;
  for (let index = lines.length - 1; index >= 0 && kept < MAX_TAIL_LENGTH; index--) {
    const line = lines[index] ?? '';
    const read = line.length > 2 * MAX_TAIL_LENGTH ? line.slice(-2 * MAX_TAIL_LENGTH) : line;
    const [secret] = findSecrets(read, () => false);
    const left =
      secret === undefined ? line : `[left out: a line that looks like a secret (${secret.kind})]`;
    lines[index] = left;
    kept += left.length + 1;
  }
  return lines.join('\n');
}

/** What one run of `check` read. */
export function readingOf(
  check: Extract<PlannedCheck, { kind: 'run' }>,
  run: CheckRun,
): GravityReading {
  const ran = {
    ...(check.check === undefined ? {} : { check: check.check }),
    ...(check.setup === undefined ? {} : { setup: check.setup }),
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
export const checkName = ({
  check,
  command,
}: {
  check?: CheckName | undefined;
  command: string;
}): string =>
  check === undefined ? `the check "${command}"` : `the check "${check}" (${command})`;

/** The last line of `text` that is not blank. */
const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);

const environment = (summary: string): Ending => ({
  kind: 'blocked',
  blockerKind: 'environment',
  summary,
});

/**
 * A setup that did not pass: no fact about the tree under check, so never a failure along
 * `onFail`, but the attempt's environment, or a cancel at the engine's stop (ADR 0140).
 */
function settleSetup(reading: Exclude<GravityReading, { result: 'skipped' }>): Ending {
  const setup = `the setup "${reading.command}"`;
  switch (reading.result) {
    case 'exited':
      return environment(`${setup} failed with exit code ${reading.exitCode}`);
    case 'signaled':
      return environment(`${setup} was ended by ${reading.signal}`);
    case 'killed':
      switch (reading.killed) {
        case 'stopped':
          return { kind: 'cancelled' };
        case 'timed-out':
          return environment(`${setup} did not finish within its timeout or the step's deadline`);
        case 'too-much-output':
          return environment(`${setup} wrote more output than the process runner's limit`);
        default: {
          const unhandled: never = reading.killed;
          throw new Error(`Unhandled kill ${JSON.stringify(unhandled)}`);
        }
      }
    case 'unstarted': {
      const why = lastLine(reading.tail);
      return environment(`${setup} could not start${why === undefined ? '' : `: ${why}`}`);
    }
    default: {
      const unhandled: never = reading;
      throw new Error(`Unhandled reading ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The step's outcome from its readings: the first that did not pass decides (ADR 0069). */
export function settleReadings(readings: readonly GravityReading[]): Ending {
  const decisive = readings.find((reading) => !passed(reading));
  if (decisive === undefined) return { kind: 'succeeded', output: null };
  if (decisive.result !== 'skipped' && decisive.setup === true) return settleSetup(decisive);
  switch (decisive.result) {
    case 'skipped':
      throw new Error('A skipped check passes');
    // The same tree would read the same again: no retry, the onFail route or Stuck.
    case 'exited': {
      const reason = `${checkName(decisive)} failed with exit code ${decisive.exitCode}`;
      return { kind: 'failed', retryable: false, reason };
    }
    // A crash of the code under check is a failure of the tree, as an exit code is.
    case 'signaled': {
      const reason = `${checkName(decisive)} was ended by ${decisive.signal}`;
      return { kind: 'failed', retryable: false, reason };
    }
    case 'killed':
      switch (decisive.killed) {
        case 'stopped':
          return { kind: 'cancelled' };
        case 'timed-out': {
          const reason = `${checkName(decisive)} did not finish by the step's deadline`;
          return { kind: 'failed', retryable: false, reason };
        }
        // Another attempt would write as much again; a human makes the check quieter.
        case 'too-much-output':
          return environment(
            `${checkName(decisive)} wrote more output than the process runner's limit`,
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
        `${checkName(decisive)} could not start${why === undefined ? '' : `: ${why}`}`,
      );
    }
    default: {
      const unhandled: never = decisive;
      throw new Error(`Unhandled reading ${JSON.stringify(unhandled)}`);
    }
  }
}
