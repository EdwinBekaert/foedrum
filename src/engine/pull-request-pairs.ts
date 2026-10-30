// The check of the Brewery's open pull requests of one repository against each other (ADR 0230):
// each intake pass, after the base check, merge-trees two open heads it has no record of, and
// records what it found for each of the two batches. A conflict shows on the status comment and in
// the merge brief's evidence, and never holds "Ready to merge".

import { MAX_CONFLICTS } from '../schemas/store.ts';
import type { BaseCheckRepository, MergeTreeResult } from './base-check.ts';
import type { CommandLog } from './command-log.ts';
import { repositoryOf } from './driver.ts';
import type { Batch, State } from './fold.ts';
import { openOf } from './pull-request.ts';
import { sameRepo } from './task-tree.ts';

export interface PairCheckOptions {
  log: CommandLog;
  repositories: readonly BaseCheckRepository[];
  clock: () => Date;
  /** What it could not do: a branch it could not read, a merge-tree that failed, a refused record. */
  failed: (what: string, error: unknown) => void;
}

/** An open pull request of a batch, with the head its latest push recorded. */
interface Open {
  batchId: string;
  url: string;
  head: string;
  branch: string;
}

/** The open pull request of `batchId` as `state` has it, when it is one. */
const openIn = (state: State, batchId: string): Open | undefined => {
  const batch = state.batches.get(batchId);
  const open = batch === undefined ? undefined : openOf(state, batch);
  return open === undefined ? undefined : { batchId, ...open };
};

/** Whether `batchId`'s fold has the merge-tree of `side`'s head with `other`'s. */
const recorded = (state: State, side: Open, other: Open): boolean => {
  const latest = state.batches.get(side.batchId)?.pairChecks?.[other.url];
  return (
    latest?.pullRequest === side.url && latest.head === side.head && latest.otherHead === other.head
  );
};

/** One pass: merge-trees every pair of open heads of one repository not checked yet. */
export const checkPairs = async (options: PairCheckOptions, signal: AbortSignal): Promise<void> => {
  const { log, repositories, clock, failed } = options;
  // The open pull requests of each repository, in the log's order.
  const groups = new Map<BaseCheckRepository, Open[]>();
  const start = log.state();
  for (const batchId of start.batches.keys()) {
    const open = openIn(start, batchId);
    if (open === undefined) continue;
    let repository: BaseCheckRepository;
    try {
      repository = repositoryOf(start, batchId, repositories);
    } catch {
      // A repository without a base check: nothing to check it with.
      continue;
    }
    groups.set(repository, [...(groups.get(repository) ?? []), open]);
  }
  // Each bottle branch's remote tip once per pass, and only for a pair that is due; `undefined`
  // when it could not be read or is gone.
  const branchTips = new Map<string, string | undefined>();
  const pushedBy = async (repository: BaseCheckRepository, open: Open): Promise<boolean> => {
    const key = JSON.stringify([repository.repo, open.branch]);
    if (!branchTips.has(key)) {
      let tip: string | undefined;
      try {
        tip = await repository.branchTip(open.branch, signal);
      } catch (error) {
        failed(`reading the tip of ${open.branch} in ${repository.repo}`, error);
      }
      branchTips.set(key, tip);
    }
    // A branch someone else pushed to is not checked (ADR 0198); a gone one is closing.
    return branchTips.get(key) === open.head;
  };
  const record = (side: Open, other: Open, files: string[]): void => {
    const event = {
      type: 'pull_request.pair_checked',
      batchId: side.batchId,
      pullRequest: side.url,
      head: side.head,
      other: other.url,
      otherHead: other.head,
      ...(files.length === 0 ? {} : { conflicts: files }),
    } as const;
    const decision = log.issue({ kind: 'record', event }, clock());
    if (decision.kind === 'refused') {
      failed(`recording the check of ${side.url} against ${other.url}`, new Error(decision.reason));
    }
  };
  for (const [repository, opens] of groups) {
    for (const [i, one] of opens.entries()) {
      for (const two of opens.slice(i + 1)) {
        if (signal.aborted) return;
        // Each side on its own: a pass killed between the two records left one out.
        const state = log.state();
        const due = [
          ...(recorded(state, one, two) ? [] : [[one, two] as const]),
          ...(recorded(state, two, one) ? [] : [[two, one] as const]),
        ];
        if (due.length === 0) continue;
        if (!(await pushedBy(repository, one)) || !(await pushedBy(repository, two))) continue;
        if (signal.aborted) return;
        let merged: MergeTreeResult;
        try {
          merged = await repository.mergeTree(one.head, two.head, signal);
        } catch (error) {
          failed(`merging ${one.url} with ${two.url}`, error);
          continue;
        }
        // A pass given up at its deadline records nothing more.
        if (signal.aborted) return;
        const files = merged.kind === 'conflicts' ? merged.files.slice(0, MAX_CONFLICTS) : [];
        // Other writers append beside the pass (ADR 0044): a head that moved meanwhile is a new pair.
        const now = log.state();
        if (openIn(now, one.batchId)?.head !== one.head) continue;
        if (openIn(now, two.batchId)?.head !== two.head) continue;
        for (const [side, other] of due) record(side, other, files);
      }
    }
  }
};

/** Another open pull request the batch's open pull request conflicts with, and in which files. */
export interface PairConflict {
  pullRequest: string;
  other: string;
  conflicts: readonly string[];
}

/**
 * The repository a batch writes in, as the log names it; `undefined` for a Brewery issue's batch,
 * which opens a pull request only in a one-repository Brewery (`repositoryOf`), so it shares that
 * repository with every other.
 */
const repoOf = (state: State, batch: Batch): string | undefined =>
  batch.repo ?? state.subOrders.get(batch.issue)?.repo;

/**
 * What the pair checks of the open pull request of `batch` say now: the other open pull requests
 * of its repository it conflicts with, and whether every other one was checked clean. A record
 * counts only while both heads are the ones the batches' latest pushes recorded.
 */
export const pairsOf = (
  state: State,
  batch: Batch,
): { conflicts: PairConflict[]; clean: boolean } => {
  const open = openIn(state, batch.id);
  if (open === undefined) return { conflicts: [], clean: false };
  const repo = repoOf(state, batch);
  const others = [...state.batches.values()].flatMap((each) => {
    if (each.id === batch.id) return [];
    const other = repoOf(state, each);
    const same = repo === undefined || other === undefined || sameRepo(repo, other);
    const found = same ? openIn(state, each.id) : undefined;
    return found === undefined ? [] : [found];
  });
  const conflicts: PairConflict[] = [];
  let checked = 0;
  for (const other of others) {
    if (!recorded(state, open, other)) continue;
    checked++;
    const files = batch.pairChecks?.[other.url]?.conflicts;
    if (files !== undefined)
      conflicts.push({ pullRequest: open.url, other: other.url, conflicts: files });
  }
  return {
    conflicts,
    clean: others.length > 0 && checked === others.length && conflicts.length === 0,
  };
};
