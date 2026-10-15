// Reads the records under .git/worktrees/ for the cores (ADR 0021): the folder each record's
// gitdir file names, whether that folder is still there, and its lock.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RecordFact } from './core.ts';

const readText = (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

// A relative gitdir (worktree.useRelativePaths) is relative to the record.
export const readRecords = async (commonDir: string): Promise<RecordFact[]> => {
  const root = join(commonDir, 'worktrees');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records: RecordFact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const gitdir = (await readText(join(dir, 'gitdir')))?.trim() ?? '';
    const folder = gitdir === '' ? undefined : dirname(resolve(dir, gitdir));
    const lockReason = (await readText(join(dir, 'locked')))?.replace(/\r?\n$/, '');
    const folderExists = folder !== undefined && existsSync(folder);
    records.push({ dir, name: entry.name, folder, folderExists, lockReason });
  }
  return records;
};
