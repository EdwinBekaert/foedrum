// The delete of old files under a folder, shared by rack's deleteTemporary (ADR 0383) and the
// worktree cleanup.

import type { Dirent } from 'node:fs';
import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode } from '../platform/errors.ts';

/** The file system calls the delete of old files makes; injected by tests. */
export interface TemporaryFilesIo {
  readdir: (path: string) => Promise<Dirent[]>;
  lstat: (path: string) => Promise<{ mtimeMs: number }>;
  remove: (path: string) => Promise<void>;
}

export const NODE_FILES: TemporaryFilesIo = {
  readdir: (path) => readdir(path, { withFileTypes: true }),
  lstat,
  remove: rm,
};

/**
 * Deletes the files under `folder` last changed before `before`, never following a link and never
 * entering a folder that holds a `.git` entry, and the folders that leaves empty. An entry gone meanwhile is skipped; one it cannot read or delete is
 * skipped and counted as left, for the next run. How many went, and how many were left.
 */
export const deleteOldFiles = async (
  files: TemporaryFilesIo,
  folder: string,
  before: number,
): Promise<{ deleted: number; left: number }> => {
  const done = { deleted: 0, left: 0 };
  const tried = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await call();
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') done.left += 1;
      return undefined;
    }
  };
  const walk = async (inside: string): Promise<void> => {
    const entries = (await tried(() => files.readdir(inside))) ?? [];
    // A worktree or a scratch clone: whatever made it removes it (ADR 0389).
    if (entries.some((entry) => entry.name === '.git')) return;
    for (const entry of entries) {
      const path = join(inside, entry.name);
      if (entry.isDirectory()) {
        const deleted = done.deleted;
        await walk(path);
        if (
          done.deleted > deleted &&
          (await files.readdir(path).catch(() => undefined))?.length === 0
        ) {
          await rmdir(path).catch(() => {});
        }
      } else if (
        entry.isFile() &&
        ((await tried(() => files.lstat(path)))?.mtimeMs ?? before) < before
      ) {
        if (await tried(() => files.remove(path).then(() => true))) done.deleted += 1;
      }
    }
  };
  await walk(folder);
  return done;
};
