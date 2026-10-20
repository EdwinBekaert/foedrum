// The task-tree branches the cleanup keeps (ADR 0084, ADR 0092), as `foedrum status` lists them:
// pure, from the claims and what git says of each branch. kept-branches-git.ts reads git.

import { parseAttemptBranch } from '../workspace/attempt-worktrees.ts';
import { columns } from './columns.ts';

/** What git says of one branch the claims name, in the clone of its batch's repository. */
export type BranchReading =
  /** `ahead`: the commits past the batch's start; undefined when the start is unknown. */
  | { kind: 'read'; clone: string; tip: string; ahead: number | undefined }
  /** The branch is no longer in the clone: someone took the commits and dropped it. */
  | { kind: 'gone' }
  | { kind: 'unread'; reason: string };

const commits = (ahead: number | undefined): string =>
  ahead === undefined
    ? 'start unknown'
    : `${ahead} ${ahead === 1 ? 'commit' : 'commits'} past the start`;

/**
 * The lines `foedrum status` adds for the branches the cleanup keeps: the ones of `unpushed`
 * (`Claims.unpushed`) whose tip is not the batch's start, each with its batch, its commits past the
 * start and the line that drops it. None when nothing is kept.
 */
export const keptBranchLines = (
  unpushed: ReadonlyMap<string, string>,
  readings: ReadonlyMap<string, BranchReading>,
): string[] => {
  const rows = [...unpushed].flatMap(([branch, start]): string[][] => {
    // The claims name attempt branches only.
    const batchId = parseAttemptBranch(branch)?.batchId ?? '';
    const reading = readings.get(branch) ?? { kind: 'unread', reason: '' };
    switch (reading.kind) {
      case 'gone':
        return [];
      case 'unread':
        return [[batchId, branch, `not read${reading.reason === '' ? '' : `: ${reading.reason}`}`]];
      case 'read':
        // As the cleanup decides: a branch at the start holds nothing (ADR 0084).
        if (reading.tip === start) return [];
        return [
          [batchId, branch, commits(reading.ahead), `in ${reading.clone}: git branch -D ${branch}`],
        ];
      default: {
        const unhandled: never = reading;
        throw new Error(`Unhandled reading ${JSON.stringify(unhandled)}`);
      }
    }
  });
  if (rows.length === 0) return [];
  const count = `${rows.length} kept ${rows.length === 1 ? 'branch' : 'branches'}`;
  return [
    `${count}: commits of ended batches that no push recorded (ADR 0084); take them, then drop the branch`,
    '',
    ...columns(rows),
  ];
};
