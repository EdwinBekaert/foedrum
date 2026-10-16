// The real path of a path that may not exist yet (ADR 0048): the real path of its deepest
// existing ancestor, which resolves symbolic links, junctions, Windows short names (PROGRA~1) and
// case, with the rest of the path appended.
//
// The path is not normalised first. The operating system reads `link/..` itself: Windows drops
// it before it looks at the disk, POSIX goes to the parent of the link's target, so a path made
// lexically clean first could name another file than the one a read would open.

import { realpathSync } from 'node:fs';
import { join, parse, sep } from 'node:path';

/**
 * How a Windows path would go further than a local drive if it were opened: through the network
 * or a device (`\\server\share`, `\\?\…`, `\\.\…`), or from a drive's current folder or the
 * current drive (`D:x`, `\x`, `/d/x`). Undefined for a full drive path or a relative one.
 */
export function windowsPathProblem(path: string): 'network' | 'no-drive' | undefined {
  if (/^[\\/]{2}/.test(path)) return 'network';
  if (/^[\\/]|^[A-Za-z]:(?![\\/])/.test(path)) return 'no-drive';
  return undefined;
}

// A part of the path that does not exist (yet): try its parent.
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

/** Resolves an absolute path; throws on anything but a missing part (EACCES, ELOOP, …). */
export function realPath(
  path: string,
  realpath: (path: string) => string = realpathSync.native,
): string {
  const { root } = parse(path);
  const parts = path
    .slice(root.length)
    .split(sep === '\\' ? /[\\/]/ : '/')
    .filter((part) => part !== '');
  // The root itself is the last try: when even that is missing, its error is thrown.
  for (let kept = parts.length; ; kept--) {
    try {
      return join(realpath(root + parts.slice(0, kept).join(sep)), ...parts.slice(kept));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (kept === 0 || code === undefined || !MISSING.has(code)) throw error;
    }
  }
}
