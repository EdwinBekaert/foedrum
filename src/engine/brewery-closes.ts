// The close of a Brewery issue whose work merged (ADR 0296): a target repository's pull request
// names no Brewery issue, so no `Closes` line closes it on the merge; the engine does, through the
// ledger, once every pull request of the issue's batch merged. What is due comes from the recorded
// events alone (`pull_request.ended`); each effect is found by its key before it is applied
// (ADR 0033). A claimed batch's Brewery issue closes with its claim's release (ADR 0144). A split
// order's issue closes once every sub-order its latest breakdown keeps merged (ADR 0293).

import { pullRequestOf } from '../schemas/events.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import { commentId, effectMarker, type IssueMarks } from './claim-effects.ts';
import { breweryIssueOf, latestOf } from './claim-orders.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { Batch, State } from './fold.ts';
import { orderEnd, subOrderRows } from './order-end.ts';

export interface BreweryClosesOptions {
  marks: Pick<IssueMarks, 'findComment' | 'comment' | 'issueState' | 'setIssueState'>;
  /** The Brewery repository, `owner/name`. */
  brewery: string;
}

/** The effects of a close, by the name its key carries: the comment first, then the close. */
const closeEffects = { comment: 'close.comment', issue: 'close.issue' } as const;

/** A close that is due: the Brewery issue, and the comment that names what merged. */
interface DueClose {
  issue: number;
  body: string;
}

/** `pullRequests` as `owner/name#<n>`. */
const namesOf = (pullRequests: readonly string[]): string[] =>
  pullRequests.map((url) => {
    const { repo, number } = pullRequestOf(url);
    return `${repo}#${number}`;
  });

/** The pull requests of `batch` when every one of them merged; none while one is open or closed. */
const mergedWork = (batch: Batch): readonly string[] => {
  const { lane } = batch;
  if (lane.kind !== 'on_tap') return [];
  const ends = batch.pullRequestEnds ?? {};
  return lane.pullRequests.every((url) => ends[url] === 'merged') ? lane.pullRequests : [];
};

/**
 * The close due for `batch`: a Brewery issue's own batch whose pull requests all merged, while it
 * is the issue's latest batch, so an older one never closes an issue ordered again since.
 */
const dueClose = (state: State, batch: Batch): DueClose | undefined => {
  if (batch.repo !== undefined) return undefined;
  const issue = breweryIssueOf(state, batch);
  if (issue === undefined || !latestOf(state, batch, issue)) return undefined;
  // A split order's batch opened no pull request: its sub-orders' are its work (ADR 0293).
  if (batch.decomposed === true) {
    const end = orderEnd(subOrderRows(state, batch.issue));
    if (batch.lane.kind !== 'on_tap' || end?.kind !== 'done') return undefined;
    const names = namesOf(end.pullRequests).join(', ');
    return { issue, body: `Every sub-order merged: ${names}. Foedrum closes this order.` };
  }
  const merged = mergedWork(batch);
  if (merged.length === 0) return undefined;
  return { issue, body: `Merged as ${namesOf(merged).join(', ')}; Foedrum closes this issue.` };
};

/**
 * The close of each Brewery issue whose batch's pull requests all merged, for the driver: a comment
 * naming them, then the close. A person who deleted the issue ends both as `gone`, never a failure.
 * One closed already gets no comment.
 */
export const breweryCloseEffects = (options: BreweryClosesOptions): DriverEffects => {
  const { marks, brewery } = options;
  // The close behind each key `due` gave; the driver asks `due` before it applies a key.
  const due = new Map<string, DueClose>();
  const dueFor = (key: string): DueClose => {
    const found = due.get(key);
    if (found === undefined) throw new Error(`No Brewery issue close ${key} is due`);
    return found;
  };
  const comment: EffectTarget = {
    find: async (key, signal) => {
      const { issue } = dueFor(key);
      const state = await marks.issueState(brewery, issue, signal);
      if (state === 'gone') return { result: 'gone' };
      const id = await marks.findComment(brewery, issue, effectMarker(key), signal);
      if (id !== undefined) return { result: commentId(id) };
      // Closed already, as a Closes line closed it before ADR 0296: nothing is said again.
      return state === 'closed' ? { result: 'closed' } : undefined;
    },
    apply: async (key, signal) => {
      const { issue, body } = dueFor(key);
      return commentId(
        await marks.comment(brewery, issue, `${body}\n\n${effectMarker(key)}`, signal),
      );
    },
  };
  const close: EffectTarget = {
    find: async (key, signal) => {
      const state = await marks.issueState(brewery, dueFor(key).issue, signal);
      if (state === 'gone') return { result: 'gone' };
      return state === 'closed' ? { result: null } : undefined;
    },
    apply: async (key, signal) => {
      await marks.setIssueState(brewery, dueFor(key).issue, 'closed', signal);
      return null;
    },
  };
  const targetOf = (key: string): EffectTarget =>
    effectKey.decode(key).effect === closeEffects.comment ? comment : close;
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      const found = batch === undefined ? undefined : dueClose(state, batch);
      if (found === undefined) return [];
      const keys: BatchEffectKey[] = [
        { batchId, effect: closeEffects.comment },
        { batchId, effect: closeEffects.issue },
      ];
      for (const key of keys) due.set(effectKey.encode(key), found);
      return keys;
    },
    target: {
      find: (key, signal) => targetOf(key).find(key, signal),
      apply: (key, signal) => targetOf(key).apply(key, signal),
    },
  };
};
