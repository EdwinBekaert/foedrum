// A bounded, link-safe read of one file inside a root: an out doc, a check's report. Only a regular
// file, reached through no link, of at most a given size (ADR 0047, #134).

import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { pathInside } from './paths.ts';

/** A file as the reader found it. */
export type BoundedRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'unread'; reason: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Reads an out doc of at most `maxBytes`, only a regular file, and only inside `root`. */
export function readOutDocFile(
  file: string,
  maxBytes: number,
  root: string,
  open: (path: string, flags: number) => number = openSync,
  stat: (path: string, options: { bigint: true }) => BigIntStats = statSync,
): BoundedRead {
  const tooLarge: BoundedRead = { kind: 'unread', reason: `it is larger than ${maxBytes} bytes` };
  const notAFile: BoundedRead = { kind: 'unread', reason: 'it is not a regular file' };
  try {
    const found = lstatSync(file, { throwIfNoEntry: false });
    if (found === undefined) return { kind: 'missing' };
    // A link could point the out doc, which reaches the event log, at any file of the machine.
    if (!found.isFile()) return notAFile;
    // So could a linked folder on its path (a junction needs no privilege on Windows), or `..`.
    const real = realpathSync(file);
    if (pathInside(realpathSync(root), real) === undefined) {
      return { kind: 'unread', reason: 'it is outside the worktree' };
    }
    // The identity of the file checked, taken before the open: a folder swapped for a link after
    // the check is followed by the open and by any later look at the same path (#134, review of
    // #136). Big integers, as a Windows file id may not fit a number.
    const checked = stat(real, { bigint: true });
    // Where the platform has it, a link swapped in since the checks is not followed (ADR 0047).
    const fd = open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // O_NOFOLLOW covers only the last part of the path: the file opened must be the one checked.
      const held = fstatSync(fd, { bigint: true });
      // A swap that came before the identity was taken and is still in place moved the real path
      // (review of #136); one made and undone within these few calls is not seen.
      if (held.dev !== checked.dev || held.ino !== checked.ino || realpathSync(file) !== real) {
        return { kind: 'unread', reason: 'it changed while it was read' };
      }
      if (!held.isFile()) return notAFile;
      // A hard link keeps its name in the worktree, but its content may be any file of the volume.
      if (held.nlink > 1n) return { kind: 'unread', reason: 'it has more than one link' };
      if (held.size > BigInt(maxBytes)) return tooLarge;
      // Never more than the limit, even when the file grew since.
      const buffer = Buffer.alloc(maxBytes + 1);
      const length = readSync(fd, buffer, 0, maxBytes + 1, 0);
      if (length > maxBytes) return tooLarge;
      return { kind: 'text', text: buffer.toString('utf8', 0, length) };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { kind: 'unread', reason: messageOf(error) };
  }
}
