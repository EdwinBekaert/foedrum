// Robust removal of files and folders (architecture §13, file locks). On Windows a folder can
// carry the ReadOnly attribute and a file can be held open briefly by another process (an
// editor, an antivirus scan, a process whose working directory is inside the folder), so a
// plain delete fails with EPERM, EBUSY or ENOTEMPTY. removeTree clears the read-only bits and
// retries those errors with a short exponential backoff before giving up.

import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type RemovePath = (path: string) => Promise<void>;

export interface RemoveTreeOptions {
  attempts?: number;
  delayMs?: number;
  removePath?: RemovePath;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

// Adds the owner's write bit (and, for folders, read and search) to the path and everything
// below it. On Windows, Node maps the write bit to the ReadOnly attribute. Symbolic links are
// left alone, so nothing outside the tree changes.
export const clearReadOnly = async (path: string): Promise<void> => {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink()) return;
  const wanted = stats.isDirectory() ? 0o700 : 0o200;
  if ((stats.mode & wanted) !== wanted) await chmod(path, (stats.mode & 0o7777) | wanted);
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(path)) await clearReadOnly(join(path, entry));
};

const removeRecursively: RemovePath = (path) => rm(path, { recursive: true, force: true });

export const removeTree = async (path: string, options: RemoveTreeOptions = {}): Promise<void> => {
  const { attempts = 5, delayMs = 50, removePath = removeRecursively, sleep = delay } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      await clearReadOnly(path);
      await removePath(path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= attempts || code === undefined || !RETRYABLE_CODES.has(code)) throw error;
      await sleep(delayMs * 2 ** (attempt - 1));
    }
  }
};
