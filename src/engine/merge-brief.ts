// When a brewed pull request is ready to merge (ADR 0225): the latest record of the checks on the
// head the batch pushed finished with none failed, its latest base check found no conflict and no
// failing check on the merged tree, and the batch is On tap. And the merge briefs the ledger
// recorded, one per ready record, and those outdated, to be hidden (ADR 0229). Pure: the brief's
// effects and the status comment read it.

import { createHash } from 'node:crypto';
import type { HeadCheck } from '../schemas/events.ts';
import { MergeBrief } from '../schemas/status-comment.ts';
import { type BatchEffectKey, PushResult } from '../schemas/store.ts';
import { effectKey } from './effect-key.ts';
import { type Batch, headChecksText, type State } from './fold.ts';
import { checkPassed } from './pr-checks.ts';
import { openOf, recordedPushes } from './pull-request.ts';
import type { BriefLine } from './status-comment.ts';

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

/** The effect that hides the `n`th merge brief of `batchId` as outdated (ADR 0229). */
export const hiddenKey = (batchId: string, n: number): BatchEffectKey => ({
  batchId,
  effect: `brief.${n}.hidden`,
});

/** The merge briefs the ledger recorded for `batchId`, the `n`th at `n - 1`. */
const recordedBriefs = (state: State, batchId: string): MergeBrief[] => {
  const briefs: MergeBrief[] = [];
  for (let n = 1; ; n++) {
    const key = effectKey.encode(briefKey(batchId, n));
    if (!state.effects.has(key)) return briefs;
    const parsed = MergeBrief.safeParse(state.effects.get(key));
    if (!parsed.success) throw new Error(`The ledger's ${key} is not a merge brief`);
    briefs.push(parsed.data);
  }
};

/** The latest merge brief the ledger recorded for `batchId`, if any, and the number of the next. */
export const latestBrief = (
  state: State,
  batchId: string,
): { next: number; latest: MergeBrief | undefined } => {
  const briefs = recordedBriefs(state, batchId);
  return { next: briefs.length + 1, latest: briefs.at(-1) };
};

/** Whether the ledger recorded the hide of the `n`th merge brief of `batchId`. */
const isHidden = (state: State, batchId: string, n: number): boolean =>
  state.effects.has(effectKey.encode(hiddenKey(batchId, n)));

/** Whether `brief` was posted for `record`: the same pull request, head and checks. */
const briefOf = (brief: MergeBrief | undefined, record: ReadyRecord): boolean =>
  brief?.pullRequest === record.pullRequest &&
  brief.head === record.head &&
  brief.digest === record.digest;

/** The latest merge brief of `batchId` while it is of `ready` and not hidden (ADR 0229). */
export const currentBrief = (
  state: State,
  batchId: string,
  ready: ReadyRecord,
): MergeBrief | undefined => {
  const { next, latest } = latestBrief(state, batchId);
  return briefOf(latest, ready) && !isHidden(state, batchId, next - 1) ? latest : undefined;
};

/** The latest merge brief of `batch` while it is of the record that makes it ready now. */
const briefNow = (state: State, batch: Batch): MergeBrief | undefined => {
  const ready = readyOf(state, batch);
  return ready === undefined ? undefined : currentBrief(state, batch.id, ready);
};

/**
 * What the status comment says of the open pull request of `batch` (ADR 0229): its current brief,
 * else that it has none; nothing once no pull request of it is open.
 */
export const briefLine = (state: State, batch: Batch): BriefLine | undefined => {
  const now = briefNow(state, batch);
  if (now !== undefined) return now;
  const open = openOf(state, batch);
  return open === undefined ? undefined : { pullRequest: open.url };
};

/**
 * The latest push of `batchId` that left its branch somewhere: at the commit it pushed, at someone
 * else's (`moved`), or gone. A push that pushed nothing (`empty`, `refused`) left it where the one
 * before did.
 */
const latestMove = (state: State, batchId: string): PushResult | undefined =>
  recordedPushes(state, batchId)
    .flatMap((recorded) => {
      const parsed = PushResult.safeParse(recorded);
      return parsed.success ? [parsed.data] : [];
    })
    .filter(({ empty, refused }) => empty !== true && refused === undefined)
    .at(-1);

/** Whether `pushed` left the pull request's head at another commit than `head`, or at none. */
const movedFrom = (pushed: PushResult | undefined, head: string): boolean =>
  pushed !== undefined && (pushed.gone === true || (pushed.moved ?? pushed.commit) !== head);

/**
 * The merge briefs of `batch` to hide as outdated (ADR 0229), by their number: recorded, not hidden
 * yet, of a pull request with no recorded end, and either of a head the pull request is no longer
 * at (the batch's latest push, or a base check that found someone else's push) or followed by a
 * later brief. A record that goes pending or fails on the same head outdates nothing.
 */
export const outdatedBriefs = (state: State, batch: Batch): { n: number; brief: MergeBrief }[] => {
  const briefs = recordedBriefs(state, batch.id);
  const pushed = latestMove(state, batch.id);
  return briefs.flatMap((brief, i) => {
    const n = i + 1;
    if (isHidden(state, batch.id, n)) return [];
    if (batch.pullRequestEnds?.[brief.pullRequest] !== undefined) return [];
    const branchMoved = batch.baseChecks?.some(
      (check) => check.pullRequest === brief.pullRequest && check.branchMoved !== undefined,
    );
    const outdated = n < briefs.length || branchMoved === true || movedFrom(pushed, brief.head);
    return outdated ? [{ n, brief }] : [];
  });
};
