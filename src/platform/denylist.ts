// Where the local gate's personal denylist is, and whether it can be read (ADR 0114): the file
// FOEDRUM_DENYLIST names, or else ~/.config/foedrum/denylist.txt on every platform. doctor says
// whether one is set; the gate reads its words. Nothing here prints them.

/** The list's state: none, set with its text, or named and not readable. */
export type DenylistState =
  | { kind: 'none'; path: string }
  | { kind: 'set'; path: string; text: string }
  | { kind: 'unreadable'; path: string; why: string };

/** The path of the list: `FOEDRUM_DENYLIST` when it is set and not empty, else the default. */
export const denylistPath = (_env: NodeJS.ProcessEnv, _home: string): string => {
  throw new Error('not implemented');
};

/**
 * The list's state, its file read with `readFile`, which throws when it cannot. A missing default
 * file is no list; a file FOEDRUM_DENYLIST names must be there, or the gate fails closed.
 */
export const readDenylist = (
  _env: NodeJS.ProcessEnv,
  _home: string,
  _readFile: (path: string) => string,
): DenylistState => {
  throw new Error('not implemented');
};
