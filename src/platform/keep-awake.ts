// Keeping the machine awake while `brew` or `serve` has an attempt running (#476, ADR 0195): each
// platform's built-in way, held by a helper process that watches Foedrum's process id, so a killed
// Foedrum lets the hold go. Only the idle timer is held off; the display may still turn off.

import type { ExecProcess } from './processes.ts';

/** How this machine can be kept awake, or why it cannot. */
export type AwakeMechanism =
  /** Windows PowerShell calls SetThreadExecutionState and waits on Foedrum's process. */
  | { kind: 'SetThreadExecutionState'; program: string }
  /** `caffeinate -i -w <pid>` on macOS. */
  | { kind: 'caffeinate'; program: string }
  /** `systemd-inhibit` holds logind's idle and sleep lock while `tail` waits on Foedrum's process. */
  | { kind: 'systemd-inhibit'; program: string; tail: string }
  | { kind: 'none'; why: string };

export interface AwakeMechanismInputs {
  platform: NodeJS.Platform;
  /** The file a command name runs, or `undefined` when it is not on PATH. */
  resolve: (name: string) => string | undefined;
  env: Readonly<Record<string, string | undefined>>;
}

/** The mechanism this machine has: a program found by its full path, or none with why. */
export const awakeMechanism = (_inputs: AwakeMechanismInputs): AwakeMechanism => {
  throw new Error('not implemented');
};

/** The helper's program and arguments, started with no shell. */
export interface AwakeCommand {
  file: string;
  args: string[];
}

/** The helper that holds the machine awake until the process `pid` ends; none without a mechanism. */
export const awakeCommand = (
  _mechanism: AwakeMechanism,
  _pid: number,
): AwakeCommand | undefined => {
  throw new Error('not implemented');
};

/** What `brew` and `serve` tell the hold: attempts that start and end, and their own end. */
export interface AwakeHold {
  attemptStarted(): void;
  attemptEnded(): void;
  /** Lets the hold go for good: the command ends. */
  release(): void;
}

export interface KeepAwakeOptions {
  /** The helper to start; `undefined` starts nothing. */
  command: AwakeCommand | undefined;
  exec: ExecProcess;
  /** Where the helper runs. */
  cwd: string;
}

/** Holds the machine awake from the first running attempt until none runs, or until `release`. */
export const keepAwake = (_options: KeepAwakeOptions): AwakeHold => {
  throw new Error('not implemented');
};
