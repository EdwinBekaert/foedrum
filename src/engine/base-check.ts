// The check of the Brewery's open pull requests when their base moves (ADR 0198): each intake pass
// reads each base's tip as the push's own fetch reads it (ADR 0090), merge-trees the pull request's
// head against a tip that moved since its last check, and records what it found. A conflict is
// posted on the pull request through the ledger when it first appears or its files change; the
// batch stays On tap.

import type { IssueMarks } from './claim-effects.ts';
import type { CommandLog } from './command-log.ts';
import type { DriverEffects } from './driver.ts';
import type { BaseCheck, Batch } from './fold.ts';

/** What a merge-tree of a pull request's head and its base's tip came to. */
export type MergeTreeResult = { kind: 'clean' } | { kind: 'conflicts'; files: string[] };

/** A repository whose open pull requests are checked against its base. */
export interface BaseCheckRepository {
  repo: string;
  /** The branch the pull requests go into, as the remote names it (`main`). */
  base: string;
  /** The commit the remote's `base` points at now (`BranchPush.baseTip`, ADR 0090). */
  tip(base: string, signal?: AbortSignal): Promise<string>;
  /** How `head` and `tip`, both full shas the clone has, merge. */
  mergeTree(head: string, tip: string, signal?: AbortSignal): Promise<MergeTreeResult>;
}

export interface BaseCheckOptions {
  log: CommandLog;
  repositories: readonly BaseCheckRepository[];
  clock: () => Date;
  /** What it could not do: a tip it could not read, a merge-tree that failed, a refused record. */
  failed: (what: string, error: unknown) => void;
}

/** One pass: checks every open pull request whose base moved, and records each check. */
export const checkBases = async (
  _options: BaseCheckOptions,
  _signal: AbortSignal,
): Promise<void> => {
  throw new Error('not implemented');
};

/** The checks of `batch` that post a comment, each with its number from 1 (ADR 0198). */
export const conflictPosts = (_batch: Batch): { n: number; check: BaseCheck }[] => {
  throw new Error('not implemented');
};

/** The lines the status comment shows under the batch's pull requests (ADR 0198). */
export const baseCheckLines = (_batch: Batch): string[] => {
  throw new Error('not implemented');
};

export interface BaseConflictEffectsOptions {
  marks: Pick<IssueMarks, 'findComment' | 'comment'>;
  /** How long one effect may take; the driver's default when left out (`DriverEffects`). */
  deadlineMs?: number;
}

/** The comment on each pull request a conflict posts, for the driver (ADR 0198). */
export const baseConflictEffects = (_options: BaseConflictEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
