// Reads the records under .git/worktrees/ for the cores (ADR 0021): the folder each record's
// gitdir file names, whether that folder is still there, and its lock.

import type { RecordFact } from './core.ts';

export const readRecords = async (_commonDir: string): Promise<RecordFact[]> => {
  throw new Error('not implemented');
};
