// Path globs matched against paths as git names them, relative to the repository with `/` between
// folders (ADR 0201, ADR 0274).

import { posix } from 'node:path';

// A character no path git names holds, in place of a name's leading dot.
const NO_DOT = String.fromCharCode(0);
const undotted = (path: string): string =>
  path
    .split('/')
    .map((name) => (name.startsWith('.') ? `${NO_DOT}${name.slice(1)}` : name))
    .join('/');

/**
 * Whether `glob` matches `file` (ADR 0201), a wildcard also matching a name that starts with a dot,
 * which `posix.matchesGlob` alone never does: `src/auth/**` covers `src/auth/.env`. A dot the glob
 * writes still matches only a dot, also inside braces or a class (`{.env,.npmrc}`), which the plain
 * match reads.
 */
export const matchesWithDots = (file: string, glob: string): boolean =>
  posix.matchesGlob(file, glob) || posix.matchesGlob(undotted(file), undotted(glob));
