// A new terminal window that runs a command line (ADR 0222): `/foedrum:brew` opens an interactive
// step's session through `foedrum brew <issue> --new-window`, since a plugin command cannot hand a
// terminal over (ADR 0126). One command line per platform, with argument arrays.

import type { ExecProcess } from './processes.ts';

/** What the launcher is chosen from: the platform, its variables, and the programs on the PATH. */
export interface WindowFacts {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** The full path of a program on the PATH, or `undefined` when it is not there. */
  find: (name: string) => string | undefined;
}

/** The command line the new window runs, in the folder it runs in. */
export interface WindowLine {
  cwd: string;
  program: string;
  args: readonly string[];
}

export type WindowLaunch =
  | { kind: 'launch'; program: string; args: string[] }
  | { kind: 'none'; why: string };

/** The launcher that opens a window running `line`, or why none can be opened here. */
export function newWindowCommand(_facts: WindowFacts, _line: WindowLine): WindowLaunch {
  throw new Error('not implemented');
}

/** Opens a window running `line` through `exec`, or says why it could not. */
export async function openInNewWindow(
  _facts: WindowFacts,
  _line: WindowLine,
  _exec: ExecProcess,
): Promise<{ kind: 'opened' } | { kind: 'none'; why: string }> {
  throw new Error('not implemented');
}
