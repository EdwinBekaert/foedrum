// Rack, the cleanup recipe's actions (ADR 0383): archive the finished batches, delete old archive
// folders and old temporary files. The engine runs them itself, through the ledger, as it runs the
// openPullRequest action (ADR 0071); no brewer, no model.

import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AttemptEffectKey } from '../schemas/store.ts';
import { z } from '../schemas/zod.ts';
import type { AttemptRef } from './attempt-key.ts';
import { closeStillDue } from './brewery-closes.ts';
import { breweryIssueOf, claimStandingOf } from './claim-orders.ts';
import type { Ending } from './decide.ts';
import type { DriverActions } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EventStore } from './event-store.ts';
import { type Batch, batchEnded, type State } from './fold.ts';
import type { Recipe, RecipeAction, Recipes } from './recipes.ts';

/** The archive on the state branch, as rack moves batches into it and deletes its old folders. */
export interface ArchiveShelf {
  /**
   * Moves `batches/<id>/` of each of `batchIds` to `archive/<date>/<id>/`, and so the folder of any
   * batch `known` lacks, which a forget left before a crash; one already moved is left as it is.
   */
  shelve(batchIds: readonly string[], date: string, known: ReadonlySet<string>): Promise<void>;
  /** The dates of the folders `archive/<date>/`. */
  dates(): Promise<string[]>;
  /** Deletes the folders `archive/<date>/` of `dates`. */
  drop(dates: readonly string[]): Promise<void>;
}

export interface RackActionsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  recipes: Recipes;
  /** The folded state, as it is after a forget. */
  state(): State;
  store: Pick<EventStore, 'forget'>;
  shelf: ArchiveShelf;
  /** Whether an issue is open, closed or gone, read once per issue in each run. */
  issueState(
    repo: string,
    issue: number,
    signal?: AbortSignal,
  ): Promise<'open' | 'closed' | 'gone'>;
  /** The Brewery's `.foedrum/tmp` folder. */
  temporary: string;
  clock(): Date;
}

const DAY_MS = 86_400_000;
/** How many groups, or how long since the last, before the read ones are forgotten (ADR 0383). */
const CHUNK = 25;
const CHUNK_MS = 20_000;

/** A group's batch ids, as one key. */
const named = (group: readonly Batch[]): string => group.map(({ id }) => id).join(' ');

/** The effect of each of rack's actions, one per attempt. */
const EFFECTS: Partial<Record<RecipeAction, string>> = {
  archive: 'rack.archive',
  deleteArchives: 'rack.delete-archives',
  deleteTemporary: 'rack.delete-temporary',
};

/** The recipe the attempt `ref` was scheduled under, which defines its step. */
const recipeOf = (state: State, recipes: Recipes, ref: AttemptRef): Recipe | undefined => {
  const batch = state.batches.get(ref.batchId);
  const name =
    batch?.steps.get(ref.stepId)?.attempts.get(ref.attempt)?.recipe ?? batch?.recipe?.name;
  return name === undefined ? undefined : recipes.find(name);
};

/**
 * Whether `batch` is finished, as far as its events say: ended with its status comment showing it,
 * or on tap with no pull request; with no close still due, and a claim released.
 */
const finished = (state: State, batch: Batch): boolean => {
  const { lane } = batch;
  const ended = batchEnded(batch)
    ? batch.endShown === true
    : lane.kind === 'on_tap' && lane.pullRequests.length === 0;
  if (!ended || closeStillDue(state, batch)) return false;
  return batch.repo === undefined || claimStandingOf(state, batch, batch.repo) === 'released';
};

/** The issues of a batch that must be closed before it goes: its Brewery issue, and a claimed one. */
const issuesOf = (state: State, batch: Batch, brewery: string): [string, number][] => {
  const order = breweryIssueOf(state, batch);
  const issues: [string, number][] = [];
  if (order !== undefined) issues.push([brewery, order]);
  if (batch.repo !== undefined) issues.push([batch.repo, batch.issue]);
  return issues;
};

/**
 * The batches that go together, in the state's order: every batch of an issue, and a split order
 * with its sub-orders'. Only a group whose batches are all finished is listed.
 */
export const finishedGroups = (state: State): Batch[][] => {
  const root = new Map<string, string>();
  const find = (id: string): string => {
    const up = root.get(id) ?? id;
    return up === id ? id : find(up);
  };
  const join = (a: string, b: string): void => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) root.set(y, x);
  };
  const byIssue = new Map<string, string>();
  for (const batch of state.batches.values()) {
    const issue = `${batch.repo?.toLowerCase() ?? ''}#${batch.issue}`;
    join(byIssue.get(issue) ?? batch.id, batch.id);
    byIssue.set(issue, find(batch.id));
    if (batch.parentBatchId !== undefined) join(batch.parentBatchId, batch.id);
  }
  const groups = new Map<string, Batch[]>();
  for (const batch of state.batches.values()) {
    const key = find(batch.id);
    groups.set(key, [...(groups.get(key) ?? []), batch]);
  }
  return [...groups.values()].filter((group) => group.every((batch) => finished(state, batch)));
};

/**
 * Deletes the files under `folder` last changed before `before`, never following a link, and the
 * folders that leaves empty; a file it cannot delete is left for the next run. How many went.
 */
const deleteOldFiles = async (folder: string, before: number): Promise<number> => {
  const entries = await readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  let deleted = 0;
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      const inside = await deleteOldFiles(path, before);
      deleted += inside;
      if (inside > 0 && (await readdir(path)).length === 0) await rmdir(path).catch(() => {});
    } else if (entry.isFile() && (await lstat(path)).mtimeMs < before) {
      deleted += await rm(path).then(
        () => 1,
        () => 0,
      );
    }
  }
  return deleted;
};

/** Rack's actions, for the driver: one effect per attempt, which does the step's work. */
export const rackActions = (options: RackActionsOptions): DriverActions => {
  const { brewery, recipes, state, store, shelf, issueState, temporary, clock } = options;

  const olderThanOf = (ref: AttemptRef): number => {
    const olderThan = recipeOf(state(), recipes, ref)?.olderThan(ref.stepId);
    if (olderThan === undefined) throw new Error(`step ${ref.stepId} has no olderThan`);
    return olderThan;
  };

  /** Archives every finished group whose issues are all closed; the ids it archived. */
  const archive = async (signal?: AbortSignal): Promise<string[]> => {
    const before = state();
    const reads = new Map<string, Promise<'open' | 'closed' | 'gone'>>();
    const closed = async ([repo, issue]: [string, number]): Promise<boolean> => {
      const key = `${repo.toLowerCase()}#${issue}`;
      const read = reads.get(key) ?? issueState(repo, issue, signal);
      reads.set(key, read);
      return (await read) !== 'open';
    };
    const ids: string[] = [];
    // The groups read closed and not forgotten yet, and since when.
    let read: Batch[][] = [];
    let since = clock().getTime();
    // Checked again with no await before the forget: a batch may have joined a group meanwhile.
    // Rows first, then the folders: a crash between them leaves a folder the next run moves.
    const forgetRead = (): void => {
      const now = new Set(finishedGroups(state()).map((group) => named(group)));
      const gone = read
        .filter((group) => now.has(named(group)))
        .flatMap((g) => g.map(({ id }) => id));
      if (gone.length > 0) store.forget(gone);
      ids.push(...gone);
      read = [];
      since = clock().getTime();
    };
    try {
      for (const group of finishedGroups(before)) {
        const issues = group.flatMap((batch) => issuesOf(before, batch, brewery));
        let all = true;
        for (const issue of issues) all = all && (await closed(issue));
        if (!all) continue;
        read.push(group);
        // In chunks, so each forget and fold serves many groups, and a run cut off by its deadline
        // still gets further.
        if (read.length >= CHUNK || clock().getTime() - since >= CHUNK_MS) forgetRead();
      }
    } finally {
      forgetRead();
    }
    const date = clock().toISOString().slice(0, 10);
    await shelf.shelve(ids, date, new Set(state().batches.keys()));
    return ids;
  };

  /** Deletes the archive's folders whose last day ended more than `olderThan` ago. */
  const deleteArchives = async (ref: AttemptRef): Promise<string[]> => {
    const until = clock().getTime() - olderThanOf(ref);
    const old = (await shelf.dates())
      .filter((date) => Date.parse(`${date}T00:00:00Z`) + DAY_MS <= until)
      .sort();
    if (old.length > 0) await shelf.drop(old);
    return old;
  };

  const due = (current: State, ref: AttemptRef): AttemptEffectKey[] => {
    const action = recipeOf(current, recipes, ref)?.action(ref.stepId);
    const effect = action === undefined ? undefined : EFFECTS[action];
    return effect === undefined ? [] : [{ ...ref, effect }];
  };

  return {
    due,
    target: {
      // Each is done again as it is, so none is looked for.
      find: async () => undefined,
      apply: async (key, signal) => {
        const { batchId, stepId, attempt, effect } = AttemptEffectKey.parse(effectKey.decode(key));
        const ref = { batchId, stepId, attempt };
        switch (effect) {
          case EFFECTS.archive:
            return { archived: await archive(signal) };
          case EFFECTS.deleteArchives:
            return { deleted: await deleteArchives(ref) };
          case EFFECTS.deleteTemporary:
            return {
              deleted: await deleteOldFiles(temporary, clock().getTime() - olderThanOf(ref)),
            };
          default:
            throw new Error(`No rack effect ${key}`);
        }
      },
    },
    // What its effect did is its out doc.
    ending: (current, ref): Ending => {
      const [key] = due(current, ref);
      const result = key === undefined ? undefined : current.effects.get(effectKey.encode(key));
      return { kind: 'succeeded', output: z.json().parse(result ?? {}) };
    },
  };
};

/**
 * The openPullRequest action and rack's together, for the driver: each attempt goes to the one its
 * step is, and each effect to the one that called for it.
 */
export const withRack = (
  recipes: Recipes,
  openPullRequest: DriverActions,
  rack: DriverActions,
): DriverActions => {
  const of = (state: State, ref: AttemptRef): DriverActions =>
    recipeOf(state, recipes, ref)?.action(ref.stepId) === 'openPullRequest'
      ? openPullRequest
      : rack;
  const targetOf = (key: string) =>
    Object.values(EFFECTS).includes(effectKey.decode(key).effect)
      ? rack.target
      : openPullRequest.target;
  return {
    due: (state, ref) => of(state, ref).due(state, ref),
    ending: (state, ref) => of(state, ref).ending(state, ref),
    target: {
      find: (key, signal) => targetOf(key).find(key, signal),
      apply: (key, signal) => targetOf(key).apply(key, signal),
    },
  };
};
