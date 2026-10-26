// When a brewed pull request is ready to merge (ADR 0225): the latest record of the checks on the
// head the batch pushed finished with none failed, its latest base check found no conflict and no
// failing check on the merged tree, and the batch is On tap. And the merge briefs the ledger
// recorded, one per ready record. Pure: the brief's effect and the status comment read it.

import { createHash } from 'node:crypto';
import type { HeadCheck } from '../schemas/events.ts';
import { MergeBrief } from '../schemas/status-comment.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import { effectKey } from './effect-key.ts';
import { type Batch, headChecksText, type State } from './fold.ts';
import { checkPassed } from './pr-checks.ts';
import { openOf } from './pull-request.ts';

/** The record of a pull request's checks that makes it ready to merge. */
export interface ReadyRecord {
  pullRequest: string;
  head: string;
  checks: readonly HeadCheck[];
  more?: number;
  /** The first 16 hex digits of the SHA-256 of its checks, as `sameHeadChecks` compares them. */
  digest: string;
}

/**
 * The record that makes the open pull request of `batch` ready to merge, or `undefined` while it
 * is not.
 */
export const readyOf = (state: State, batch: Batch): ReadyRecord | undefined => {
  // On tap, opened by its ledger, not ended, and its branch still the batch's push.
  const open = openOf(state, batch);
  if (open === undefined) return undefined;
  // The latest record only, and only of the head the batch pushed (ADR 0213).
  const latest = batch.pullRequestChecks?.[open.url];
  if (latest?.kind !== 'finished' || latest.head !== open.head) return undefined;
  // A record keeps the failed checks first, so the ones it left out passed too.
  if (!latest.checks.every(({ conclusion }) => checkPassed(conclusion))) return undefined;
  // A conflict or a failing check on the merged tree is open; a merged tree not checked is not.
  const base = batch.baseChecks?.filter((check) => check.pullRequest === open.url).at(-1);
  if (base?.conflicts !== undefined || base?.failed !== undefined) return undefined;
  const { checks, more } = latest;
  return {
    pullRequest: open.url,
    head: open.head,
    checks,
    ...(more === undefined ? {} : { more }),
    digest: createHash('sha256').update(headChecksText(latest)).digest('hex').slice(0, 16),
  };
};

/** The effect that posts the `n`th merge brief of `batchId`. */
export const briefKey = (batchId: string, n: number): BatchEffectKey => ({
  batchId,
  effect: `brief.${n}`,
});

/** The latest merge brief the ledger recorded for `batchId`, if any, and the number of the next. */
export const latestBrief = (
  state: State,
  batchId: string,
): { next: number; latest: MergeBrief | undefined } => {
  let latest: MergeBrief | undefined;
  for (let n = 1; ; n++) {
    const key = effectKey.encode(briefKey(batchId, n));
    if (!state.effects.has(key)) return { next: n, latest };
    const parsed = MergeBrief.safeParse(state.effects.get(key));
    if (!parsed.success) throw new Error(`The ledger's ${key} is not a merge brief`);
    latest = parsed.data;
  }
};

/** Whether `brief` was posted for `record`: the same pull request, head and checks. */
export const briefOf = (brief: MergeBrief | undefined, record: ReadyRecord): boolean =>
  brief?.pullRequest === record.pullRequest &&
  brief.head === record.head &&
  brief.digest === record.digest;

/** The latest merge brief of `batch` while it is of the record that makes it ready now. */
export const briefNow = (state: State, batch: Batch): MergeBrief | undefined => {
  const ready = readyOf(state, batch);
  if (ready === undefined) return undefined;
  const { latest } = latestBrief(state, batch.id);
  return briefOf(latest, ready) ? latest : undefined;
};
