// Holding a process and everything it starts in a kill-on-close Job Object on Windows (#92,
// ADR 0039), through a PowerShell helper started by its full path: job-object.ps1.

import type { SpawnCommand } from './processes.ts';

/** One argument quoted as Windows programs read their command line (CommandLineToArgvW). */
export const windowsArgument = (_argument: string): string => {
  throw new Error('not implemented');
};

/** What the helper passes to CreateProcess: the file it starts, and its whole command line. */
export interface JobObjectLine {
  application: string;
  line: string;
}

/** The application and command line that start a command as node's spawn would. */
export const jobObjectLine = (_command: SpawnCommand): JobObjectLine => {
  throw new Error('not implemented');
};

/** How to start the helper for a command: PowerShell, its arguments, environment and directory. */
export interface JobObjectSpawn extends SpawnCommand {
  cwd: string;
}

/** Starts the command through the helper, which runs it in `cwd` inside a kill-on-close job. */
export const jobObjectCommand = (_command: SpawnCommand, _cwd: string): JobObjectSpawn => {
  throw new Error('not implemented');
};
