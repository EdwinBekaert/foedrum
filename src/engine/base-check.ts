// The check of the Brewery's open pull requests when their base moves (ADR 0198): each intake pass
// reads each base's tip as the push's own fetch reads it (ADR 0090), merge-trees the pull request's
// head against a tip that moved since its last check of that head (ADR 0226), and records what it
// found. A conflict is posted on the pull request through the ledger when it first appears or its
// files change, and a check that fails on the merged tree when it first fails (ADR 0209), which
// sends the batch back to its fix step when its recipe has the route (ADR 0226).

import type { GravityReading } from '../schemas/events.ts';
import { EffectKeyParts, MAX_CONFLICTS, MergeResult } from '../schemas/store.ts';
import { effectMarker, type IssueMarks } from './claim-effects.ts';
import type { CommandLog } from './command-log.ts';
import { type DriverEffects, repositoryOf } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import { type BaseCheck, type Batch, baseChecksOn, type State } from './fold.ts';
import type { MergedCheckDue } from './merged-checks.ts';
import { openOf } from './pull-request.ts';
import { pullRequestRoute, sentBackFrom } from './pull-request-fix.ts';
import type { Recipes } from './recipes.ts';
import { checkOf, plain, readingText, roundsText } from './status-comment.ts';

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
  /**
   * The commit the remote's bottle branch `branch` points at now (`BranchPush.remoteTip`), or
   * `undefined` when it has no such branch.
   */
  branchTip(branch: string, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * The run of the checks on the merged tree (ADR 0203): whether `batch` has checks to run, and
   * the hand-off of a clean merge, which the pass then does not record.
   */
  checks?: { wants(batch: Batch): boolean; due(due: MergedCheckDue): void };
}

export interface BaseCheckOptions {
  log: CommandLog;
  repositories: readonly BaseCheckRepository[];
  clock: () => Date;
  /** What it could not do: a tip it could not read, a merge-tree that failed, a refused record. */
  failed: (what: string, error: unknown) => void;
}

/** The ledger's effect name of the merge before a check attempt (ADR 0164). */
const MERGE_BASE = 'merge_base';

/**
 * The tip the pull request `url` of `batch` was last checked against on `head`, the latest push's:
 * its latest check of that head, else the base the batch's latest merge read (ADR 0164, ADR 0226);
 * `undefined` when neither is recorded.
 */
const lastTip = (state: State, batch: Batch, url: string, head: string): string | undefined => {
  const checked = baseChecksOn(batch, url, head).at(-1);
  if (checked !== undefined) return checked.tip;
  let merged: string | undefined;
  for (const [key, result] of state.effects) {
    const parts = EffectKeyParts.safeParse(JSON.parse(key));
    if (!parts.success || parts.data.length !== 4) continue;
    const [batchId, , , effect] = parts.data;
    if (batchId !== batch.id || effect !== MERGE_BASE) continue;
    const merge = MergeResult.safeParse(result);
    if (merge.success) merged = merge.data.base;
  }
  return merged;
};

/** One pass: checks every open pull request whose base moved, and records each check. */
export const checkBases = async (options: BaseCheckOptions, signal: AbortSignal): Promise<void> => {
  const { log, repositories, clock, failed } = options;
  const record = (
    batchId: string,
    pullRequest: string,
    branch: string,
    { tip, head }: { tip: string; head: string },
    found: { conflicts?: string[]; branchMoved?: string },
  ): void => {
    const event = {
      type: 'pull_request.base_checked',
      batchId,
      pullRequest,
      branch,
      tip,
      head,
      ...found,
    } as const;
    const decision = log.issue({ kind: 'record', event }, clock());
    if (decision.kind === 'refused') {
      failed(`recording the check of ${pullRequest}`, new Error(decision.reason));
    }
  };
  // Each base's tip once per pass; `undefined` when it could not be read.
  const tips = new Map<BaseCheckRepository, string | undefined>();
  const tipOf = async (repository: BaseCheckRepository): Promise<string | undefined> => {
    if (tips.has(repository)) return tips.get(repository);
    let tip: string | undefined;
    try {
      tip = await repository.tip(repository.base, signal);
    } catch (error) {
      failed(`reading the tip of ${repository.base} in ${repository.repo}`, error);
    }
    tips.set(repository, tip);
    return tip;
  };
  for (const batchId of [...log.state().batches.keys()]) {
    if (signal.aborted) return;
    // Each batch as the log has it now: other writers append beside the pass (ADR 0044).
    const state = log.state();
    const batch = state.batches.get(batchId);
    const open = batch === undefined ? undefined : openOf(state, batch);
    if (batch === undefined || open === undefined) continue;
    let repository: BaseCheckRepository;
    try {
      repository = repositoryOf(state, batch.id, repositories);
    } catch {
      // A repository without a base check: nothing to check it with.
      continue;
    }
    const tip = await tipOf(repository);
    if (tip === undefined || signal.aborted) continue;
    if (lastTip(state, batch, open.url, open.head) === tip) continue;
    // A bottle branch someone else pushed to holds what Foedrum never read: recorded once, and
    // checked no more (ADR 0198).
    let branchTip: string | undefined;
    try {
      branchTip = await repository.branchTip(open.branch, signal);
    } catch (error) {
      failed(`reading the tip of ${open.branch} in ${repository.repo}`, error);
      continue;
    }
    // Gone: the pull request is closing, and its end is recorded next pass.
    if (branchTip === undefined || signal.aborted) continue;
    if (branchTip !== open.head) {
      record(
        batch.id,
        open.url,
        repository.base,
        { tip, head: open.head },
        { branchMoved: branchTip },
      );
      continue;
    }
    let merged: MergeTreeResult;
    try {
      merged = await repository.mergeTree(open.head, tip, signal);
    } catch (error) {
      failed(`merging ${open.url} with ${repository.base} at ${tip}`, error);
      continue;
    }
    // A pass given up at its deadline records nothing more.
    if (signal.aborted) return;
    // A clean merge with checks to run is the merged-check run's to record (ADR 0203).
    if (merged.kind === 'clean' && repository.checks?.wants(batch) === true) {
      repository.checks.due({
        batchId: batch.id,
        pullRequest: open.url,
        branch: repository.base,
        tip,
        head: open.head,
        checked: batch.baseChecks?.filter((check) => check.pullRequest === open.url).length ?? 0,
      });
      continue;
    }
    const files = merged.kind === 'conflicts' ? merged.files.slice(0, MAX_CONFLICTS) : [];
    record(
      batch.id,
      open.url,
      repository.base,
      { tip, head: open.head },
      files.length === 0 ? {} : { conflicts: files },
    );
  }
};

/**
 * The checks of `batch` that post a comment, each with its number from 1 (ADR 0198): a conflict
 * of a pull request whose check before it was clean, or none, or conflicted in other files.
 */
export const conflictPosts = (batch: Batch): { n: number; check: BaseCheck }[] => {
  const posts: { n: number; check: BaseCheck }[] = [];
  // The files of each pull request's check before, as one text; '' when it was clean.
  const before = new Map<string, string>();
  for (const check of batch.baseChecks ?? []) {
    const files = [...(check.conflicts ?? [])].sort().join('\0');
    if (files !== '' && before.get(check.pullRequest) !== files) {
      posts.push({ n: posts.length + 1, check });
    }
    before.set(check.pullRequest, files);
  }
  return posts;
};

/** A check of a pull request whose run on the merged tree failed (ADR 0203). */
type FailedCheck = BaseCheck & { failed: GravityReading };

/**
 * The checks of `batch` whose run on the merged tree posts a comment, each with its number from 1
 * (ADR 0209): a failure of a pull request whose check before it was clean, conflicted, unchecked,
 * failed another check, or none. A check is the one the status line names (`checkOf`).
 */
export const failurePosts = (batch: Batch): { n: number; check: FailedCheck }[] => {
  const posts: { n: number; check: FailedCheck }[] = [];
  // The check each pull request's check before failed; '' when it failed none.
  const before = new Map<string, string>();
  for (const check of batch.baseChecks ?? []) {
    const { failed } = check;
    const failing = failed === undefined ? '' : checkOf(failed);
    if (failed !== undefined && before.get(check.pullRequest) !== failing) {
      posts.push({ n: posts.length + 1, check: { ...check, failed } });
    }
    before.set(check.pullRequest, failing);
  }
  return posts;
};

const conflictKey = (batchId: string, n: number) => ({ batchId, effect: `base_conflict.${n}` });
const failureKey = (batchId: string, n: number) => ({ batchId, effect: `base_check_failed.${n}` });

/** The repository and number of a pull request at `url`: `https://<host>/<owner>/<name>/pull/<n>`. */
export const pullRequestOf = (url: string): { repo: string; number: number } => {
  const found = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(new URL(url).pathname);
  const [, owner, name, number] = found ?? [];
  if (owner === undefined || name === undefined || number === undefined) {
    throw new Error(`${url} is no pull request URL of a repository`);
  }
  return { repo: `${owner}/${name}`, number: Number(number) };
};

/**
 * A post's comment without its marker: the batch's heading, `body`, and what the batch does: it
 * stays On tap, or with `rounds` Foedrum sends it back to fix it (ADR 0226).
 */
const postText = (batchId: string, body: string[], rounds?: number): string =>
  [
    `### Foedrum · batch \`${batchId}\``,
    ...body,
    `${rounds === undefined ? 'The batch stays On tap.' : `While its rounds last, Foedrum sends the batch back to fix it, at most ${roundsText(rounds)} in all, unless a person holds or skips it. The batch's status comment says how it goes.`} Foedrum checks the commit it pushed: once someone else pushes to this branch, it checks it no more (ADR 0198).`,
  ].join('\n\n');

/** The comment a conflict posts, without its marker. */
const conflictText = (batchId: string, { branch, tip, conflicts = [] }: BaseCheck): string =>
  postText(batchId, [
    `\`${branch}\` moved to \`${tip}\`, and this pull request no longer merges with it cleanly: it conflicts in`,
    conflicts.map((file) => `- ${plain(file)}`).join('\n'),
  ]);

/**
 * `text` in a fenced code block whose fence is longer than any run of backticks in it, each `<!--`
 * opened as `<!- -`: a marker a check printed would let a later post be found as posted (ADR 0033).
 */
const fenced = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text.replace(/\n$/, '').replaceAll('<!--', '<!- -')}\n${fence}`;
};

/**
 * The comment a failure on the merged tree posts, without its marker. Its tail is the one recorded,
 * already cut and with the lines that look like a secret left out (`readingOf`, ADR 0209).
 */
const failureText = (
  batchId: string,
  { branch, tip, failed }: FailedCheck,
  rounds: number | undefined,
): string =>
  postText(
    batchId,
    [
      `\`${branch}\` moved to \`${tip}\`, and this pull request merges with it cleanly but no longer passes its checks there: on the merged tree, ${plain(readingText(failed))}.`,
      ...(failed.result === 'skipped' || failed.tail === ''
        ? []
        : ['The end of its output:', fenced(failed.tail)]),
    ],
    rounds,
  );

export interface BaseConflictEffectsOptions {
  marks: Pick<IssueMarks, 'findComment' | 'comment'>;
  /** The Brewery's recipes: a batch whose recipe has the route back is fixed (ADR 0226). */
  recipes?: Recipes;
  /** How long one effect may take; the driver's default when left out (`DriverEffects`). */
  deadlineMs?: number;
}

// The id the code host answered for a comment, which the ledger keeps for good.
const commentId = (id: number): number => {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`The code host answered a comment id that is no positive integer: ${id}`);
  }
  return id;
};

/**
 * The rounds the recipe of `batch` gives a pull request that failed, when it has the route back
 * (ADR 0219); `undefined` when it stays On tap.
 */
const fixRounds = (recipes: Recipes | undefined, batch: Batch): number | undefined => {
  const name = batch.recipe?.name;
  const recipe = name === undefined ? undefined : recipes?.find(name);
  const from = recipe === undefined ? undefined : pullRequestRoute(recipe);
  return from === undefined ? undefined : recipe?.maxRounds(from, 'pull_request');
};

/**
 * The comment on the pull request each post calls for, a conflict's (ADR 0198) or a failure's on
 * the merged tree (ADR 0209), for the driver: due while the batch is on tap, or brews or is Stuck
 * after its pull request sent it back (ADR 0226), and the pull request has no recorded end, found
 * by its marker on the Brewery's own comment (ADR 0033).
 */
export const baseConflictEffects = (options: BaseConflictEffectsOptions): DriverEffects => {
  const { marks, recipes, deadlineMs } = options;
  // The comment behind each key `due` gave; the driver asks `due` before it applies a key.
  const comments = new Map<string, { repo: string; number: number; text: string }>();
  const commentFor = (key: string) => {
    const comment = comments.get(key);
    if (comment === undefined) throw new Error(`No base conflict comment ${key} is due`);
    return comment;
  };
  const target: EffectTarget = {
    find: async (key, signal) => {
      const { repo, number } = commentFor(key);
      const id = await marks.findComment(repo, number, effectMarker(key), signal);
      return id === undefined ? undefined : { result: commentId(id) };
    },
    apply: async (key, signal) => {
      const { repo, number, text } = commentFor(key);
      return commentId(
        await marks.comment(repo, number, `${text}\n\n${effectMarker(key)}`, signal),
      );
    },
  };
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      if (batch === undefined) return [];
      // On tap, or brewing or Stuck after a failure sent it back from the pull request: a tick that
      // sent it back before the post loses no post (ADR 0226).
      const { kind } = batch.lane;
      const sentBack = kind === 'brewing' || kind === 'stuck' ? sentBackFrom(batch) : undefined;
      if (kind !== 'on_tap' && sentBack === undefined) return [];
      const rounds = fixRounds(recipes, batch);
      const due = [];
      const posts = [
        ...conflictPosts(batch).map(({ n, check }) => ({
          check,
          key: conflictKey(batchId, n),
          text: conflictText(batchId, check),
        })),
        ...failurePosts(batch).map(({ n, check }) => ({
          check,
          key: failureKey(batchId, n),
          text: failureText(batchId, check, rounds),
        })),
      ];
      for (const { check, key, text } of posts) {
        if (batch.pullRequestEnds?.[check.pullRequest] !== undefined) continue;
        if (sentBack !== undefined && !sentBack.has(check.pullRequest)) continue;
        const encoded = effectKey.encode(key);
        if (state.effects.has(encoded)) continue;
        let where: { repo: string; number: number };
        try {
          where = pullRequestOf(check.pullRequest);
        } catch {
          continue;
        }
        comments.set(encoded, { ...where, text });
        due.push(key);
      }
      return due;
    },
    target,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
};
