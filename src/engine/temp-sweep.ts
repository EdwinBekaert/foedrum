// The Cellarer's sweep of the Brewery's temporary folder (ADR 0380): `.foedrum/tmp/` in the
// Brewery's clone, where people and sessions keep scratch files and Foedrum writes nothing of its
// own. Each entry goes once nothing in it changed for 2 days, so a session still at work there
// keeps its folder.

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, messageOf } from '../platform/errors.ts';
import { removeTree } from '../platform/remove.ts';

/** How long nothing in an entry must have changed before the sweep removes it. */
export const TEMP_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** What a sweep removed, and what it could not remove, each by its name in the folder. */
export interface SweepReport {
  removed: string[];
  failed: { name: string; error: string }[];
}

/** The newest change to `path` or anything below it, in ms since the epoch; links not followed. */
const newestChange = async (path: string): Promise<number> => {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = stats.mtimeMs;
  for (const name of await readdir(path)) {
    newest = Math.max(newest, await newestChange(join(path, name)));
  }
  return newest;
};

/**
 * Removes each entry of `folder` whose newest file or folder inside changed more than
 * `TEMP_AGE_MS` before `now`; nothing when the folder is missing. A link is read as itself, never
 * followed. An entry it cannot read or remove is reported and left for the next sweep.
 */
export const sweepTemp = async (
  folder: string,
  now: Date,
  remove: (path: string) => Promise<void> = removeTree,
): Promise<SweepReport> => {
  const report: SweepReport = { removed: [], failed: [] };
  const names = await readdir(folder).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  });
  for (const name of names.sort()) {
    const path = join(folder, name);
    try {
      if (now.getTime() - (await newestChange(path)) <= TEMP_AGE_MS) continue;
      await remove(path);
      report.removed.push(name);
    } catch (error) {
      report.failed.push({ name, error: messageOf(error) });
    }
  }
  return report;
};
