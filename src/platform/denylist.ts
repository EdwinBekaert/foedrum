// Where the local gate's personal denylist is, and whether it can be read (ADR 0114): the file
// FOEDRUM_DENYLIST names, or else ~/.config/foedrum/denylist.txt on every platform. doctor says
// whether one is set; the gate reads its words. Nothing here prints them.

import { join } from 'node:path';

/** The list's state: none, set with its text, or named and not readable. */
export type DenylistState =
  | { kind: 'none'; path: string }
  | { kind: 'set'; path: string; text: string }
  | { kind: 'unreadable'; path: string; why: string };

/** The path of the list: `FOEDRUM_DENYLIST` when it is set and not empty, else the default. */
export const denylistPath = (env: NodeJS.ProcessEnv, home: string): string =>
  env.FOEDRUM_DENYLIST || join(home, '.config', 'foedrum', 'denylist.txt');

/**
 * The list's state, its file read with `readFile`, which throws when it cannot. A missing default
 * file is no list; a file FOEDRUM_DENYLIST names must be there, or the gate fails closed.
 */
export const readDenylist = (
  env: NodeJS.ProcessEnv,
  home: string,
  readFile: (path: string) => string,
): DenylistState => {
  const path = denylistPath(env, home);
  try {
    return { kind: 'set', path, text: readFile(path) };
  } catch (error) {
    const missing = (error as { code?: unknown } | null)?.code === 'ENOENT';
    if (missing && !env.FOEDRUM_DENYLIST) return { kind: 'none', path };
    return {
      kind: 'unreadable',
      path,
      why: error instanceof Error ? error.message : String(error),
    };
  }
};
