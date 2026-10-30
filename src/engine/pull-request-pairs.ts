// The check of the Brewery's open pull requests of one repository against each other (ADR 0230):
// each intake pass, after the base check, merge-trees two open heads it has no record of, and
// records what it found for each of the two batches. A conflict shows on the status comment and in
// the merge brief's evidence, and never holds "Ready to merge".

import type { BaseCheckRepository } from './base-check.ts';
import type { CommandLog } from './command-log.ts';
import type { Batch, State } from './fold.ts';

export interface PairCheckOptions {
  log: CommandLog;
  repositories: readonly BaseCheckRepository[];
  clock: () => Date;
  /** What it could not do: a branch it could not read, a merge-tree that failed, a refused record. */
  failed: (what: string, error: unknown) => void;
}

/** One pass: merge-trees every pair of open heads of one repository not checked yet. */
export const checkPairs = async (
  _options: PairCheckOptions,
  _signal: AbortSignal,
): Promise<void> => {
  throw new Error('not implemented');
};

/** Another open pull request the batch's open pull request conflicts with, and in which files. */
export interface PairConflict {
  pullRequest: string;
  other: string;
  conflicts: readonly string[];
}

/**
 * What the pair checks of the open pull request of `batch` say now: the other open pull requests
 * it conflicts with, and whether every other one was checked clean.
 */
export const pairsOf = (
  _state: State,
  _batch: Batch,
): { conflicts: PairConflict[]; clean: boolean } => {
  throw new Error('not implemented');
};
