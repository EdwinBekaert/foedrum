// The real path of a path that may not exist yet (ADR 0048): the real path of its deepest
// existing ancestor, which resolves symbolic links, junctions, Windows short names (PROGRA~1) and
// case, with the rest of the path appended.

import { realpathSync } from 'node:fs';

/** Resolves an absolute path; throws on anything but a missing part (EACCES, ELOOP, …). */
export function realPath(
  _path: string,
  _realpath: (path: string) => string = realpathSync.native,
): string {
  throw new Error('not implemented');
}
