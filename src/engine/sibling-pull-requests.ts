// The pull requests of one order name each other and the merge order (ADR 0292, ADR 0013): a
// section of each sub-order pull request's body, written with the body (ADR 0227) and kept up to
// date as its siblings open and end, one revision at a time through the ledger (ADR 0033).

import { type Dependency, pullRequestOf } from '../schemas/events.ts';
import { type BatchEffectKey, SiblingResult } from '../schemas/store.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey, numberedEffects } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { State } from './fold.ts';
import {
  bodyOwner,
  digestOf,
  MAX_SIBLINGS,
  markedBody,
  openedPullRequest,
  textAboveMarker,
} from './pull-request.ts';
import type { PullRequestHost } from './pull-request-actions.ts';

/** The effect that writes revision `n` of the sibling section into `batchId`'s body. */
export const siblingKey = (batchId: string, revision: number): BatchEffectKey => ({
  batchId,
  effect: `siblings.${revision}`,
});

/** Where a sub-order's pull request is: not opened yet, open, or how it ended. */
export type SubOrderPullRequestState = 'none' | 'open' | 'merged' | 'closed';

/** A sub-order of an order, in merge order, with its latest batch's pull request. */
export interface SubOrderPullRequest {
  subOrder: number;
  repo: string;
  /** The pull request's URL, when one of its batches opened one. */
  pullRequest?: string;
  state: SubOrderPullRequestState;
}

/**
 * The sub-orders of order `order` its latest breakdown keeps, in the order their pull requests
 * merge: after every sub-order each waits for, else in the plan's order (ADR 0292).
 */
export const subOrderPullRequests = (state: State, order: number): SubOrderPullRequest[] => {
  const split = state.orders.get(order);
  if (split === undefined) return [];
  // The latest breakdown lists no sub-order it cancelled (`order.decomposed`).
  const listed = split.subOrders.flatMap((issue) => {
    const subOrder = state.subOrders.get(issue);
    return subOrder === undefined ? [] : [subOrder];
  });
  const kept = new Set(listed.map(({ issue }) => issue));
  const placed = new Set<number>();
  const sorted: typeof listed = [];
  while (sorted.length < listed.length) {
    const left = listed.filter(({ issue }) => !placed.has(issue));
    // A cycle, which a plan cannot hold, would place the rest in the plan's order.
    const next =
      left.find(({ issue }) =>
        split.dependencies.every(
          ({ subOrder, blockedBy }) =>
            subOrder !== issue || !kept.has(blockedBy) || placed.has(blockedBy),
        ),
      ) ?? left[0];
    if (next === undefined) break;
    placed.add(next.issue);
    sorted.push(next);
  }
  return sorted.map(({ issue, repo, batchIds }) => {
    // The latest of its batches that opened a pull request.
    for (const batchId of [...batchIds].reverse()) {
      const url = openedPullRequest(state, batchId);
      if (url === undefined) continue;
      const end = state.batches.get(batchId)?.pullRequestEnds?.[url];
      return { subOrder: issue, repo, pullRequest: url, state: end ?? 'open' };
    }
    return { subOrder: issue, repo, state: 'none' };
  });
};

const HEADING = '## Pull requests of this order';
/** The line that ends the section, so a revision finds where it stops. */
const END = '<!-- foedrum:siblings -->';
/** The most sub-orders a line names as waiting for one, or as one waits for. */
const MOST_NAMED = 5;

/** `items` joined, the ones past `MOST_NAMED` counted. */
const named = (items: readonly string[], joiner: string): string => {
  const shown = items.slice(0, MOST_NAMED);
  const more = items.length - shown.length;
  return [...shown, ...(more > 0 ? [`${more} more`] : [])].join(joiner);
};

/** How a sub-order's pull request stands, in words. */
export const stateText: Record<SubOrderPullRequestState, string> = {
  none: 'not opened yet',
  open: 'open',
  merged: 'merged',
  closed: 'closed without merging',
};

/**
 * The sibling section of `batchId`'s pull request body, or undefined when the batch brews no
 * sub-order of an order with two or more (ADR 0292). It names the target repositories' pull
 * requests only, never the Brewery's issues: a target repository may be public, the Brewery not.
 */
export const siblingSection = (state: State, batchId: string): string | undefined => {
  const batch = state.batches.get(batchId);
  if (batch === undefined || batch.repo !== undefined) return undefined;
  const own = state.subOrders.get(batch.issue);
  if (own === undefined || own.cancelled) return undefined;
  const entries = subOrderPullRequests(state, own.order);
  if (entries.length < 2) return undefined;
  // An older batch's pull request is not the sub-order's once a newer batch opened one.
  const mine = openedPullRequest(state, batchId);
  const picked = entries.find(({ subOrder }) => subOrder === own.issue)?.pullRequest;
  if (mine !== undefined && mine !== picked) return undefined;
  const dependencies: readonly Dependency[] = state.orders.get(own.order)?.dependencies ?? [];
  // The batch names itself the same before and after its pull request opens, so the open's section
  // is the one the next pass computes.
  const refs = new Map(
    entries.map(({ subOrder, repo, pullRequest }) => {
      if (subOrder === own.issue) return [subOrder, 'this pull request'];
      if (pullRequest === undefined) return [subOrder, repo];
      const { repo: at, number } = pullRequestOf(pullRequest);
      return [subOrder, `${at}#${number}`];
    }),
  );
  const lines = entries.map(({ subOrder, repo, state: where }, at) => {
    const blockers = dependencies.flatMap(({ subOrder: blocked, blockedBy, kind }) => {
      const ref = blocked === subOrder ? refs.get(blockedBy) : undefined;
      if (ref === undefined) return [];
      const by = state.subOrders.get(blockedBy)?.repo ?? '';
      return [kind === 'code' ? `${ref} merges` : `${ref} merges and ${by} has a release after it`];
    });
    const waiters = dependencies.flatMap(({ subOrder: waiting, blockedBy, kind }) => {
      const ref = blockedBy === subOrder ? refs.get(waiting) : undefined;
      return ref === undefined
        ? []
        : [`${ref} waits for its ${kind === 'code' ? 'merge' : 'release'}`];
    });
    const when =
      blockers.length > 0
        ? `merge after ${named(blockers, ' and ')}`
        : waiters.length > 0
          ? `merge first (${named(waiters, ', ')})`
          : 'merge in any order';
    if (subOrder === own.issue) return `${at + 1}. This pull request, in ${repo}: ${when}.`;
    return `${at + 1}. ${refs.get(subOrder) ?? repo}: ${stateText[where]}, ${when}.`;
  });
  const intro = `This pull request is one of ${entries.length} of one order. Merge them in this order:`;
  // Whole lines, within the room every body keeps for the section.
  const kept: string[] = [];
  let length = HEADING.length + intro.length + END.length + 200;
  for (const line of lines) {
    if (length + line.length + 1 > MAX_SIBLINGS) break;
    kept.push(line);
    length += line.length + 1;
  }
  const more = lines.length - kept.length;
  return [
    HEADING,
    intro,
    ...kept,
    ...(more > 0 ? [`And ${more} more pull requests of this order.`] : []),
    END,
  ].join('\n');
};

/** The sibling section `text` starts with, or undefined: it is always first (`pullRequestText`). */
const sectionOf = (text: string): string | undefined => {
  if (!text.startsWith(`${HEADING}\n`)) return undefined;
  const end = text.indexOf(`\n${END}`);
  return end < 0 ? undefined : text.slice(0, end + 1 + END.length);
};

/** `text` with `section` in place of the one it starts with, or before it when it has none. */
const withSection = (text: string, section: string): string => {
  const old = sectionOf(text);
  const rest = old === undefined ? text : text.slice(old.length).replace(/^\n+/, '');
  return rest === '' ? section : `${section}\n\n${rest}`;
};

export interface SiblingEffectsOptions {
  host: Pick<PullRequestHost, 'body' | 'update'>;
}

/** A revision that is due: the pull request it goes on, and the section it writes. */
interface DueSection {
  url: string;
  section: string;
  digest: string;
  /** How many sub-orders of the order have a pull request, which the section names. */
  opened: number;
}

/**
 * The revisions of each sub-order pull request's sibling section, for the driver: one whenever the
 * section changed since the latest recorded, as its siblings open and end, while it is open, and
 * once it merged only when a sibling opened since (ADR 0292).
 * A body someone edited is left as it is, as a later round leaves it (ADR 0227).
 */
export const siblingEffects = (options: SiblingEffectsOptions): DriverEffects => {
  const { host } = options;
  const due = new Map<string, DueSection>();
  const dueFor = (key: string): DueSection => {
    const found = due.get(key);
    if (found === undefined) throw new Error(`No sibling section ${key} is due`);
    return found;
  };
  const target: EffectTarget = {
    // Written by a run before that was killed before it recorded it, or by the open or a round.
    find: async (key, signal) => {
      const { url, section, digest, opened } = dueFor(key);
      const { batchId } = effectKey.decode(key);
      const body = await host.body(url, signal);
      if (bodyOwner(batchId, body).kind !== 'own') return undefined;
      return sectionOf(textAboveMarker(body)) === section
        ? { result: { section: digest, opened } satisfies SiblingResult }
        : undefined;
    },
    apply: async (key, signal): Promise<SiblingResult> => {
      const { url, section, digest, opened } = dueFor(key);
      const decoded = effectKey.decode(key);
      const body = await host.body(url, signal);
      const owner = bodyOwner(decoded.batchId, body);
      if (owner.kind === 'left') return { section: digest, opened, left: owner.left };
      await host.update(
        url,
        markedBody(decoded, withSection(textAboveMarker(body), section)),
        signal,
      );
      return { section: digest, opened };
    },
  };
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      const url = openedPullRequest(state, batchId);
      const end = url === undefined ? undefined : batch?.pullRequestEnds?.[url];
      // A pull request closed without merging is no part of the order's merge any more.
      if (batch === undefined || url === undefined || end === 'closed') return [];
      const section = siblingSection(state, batchId);
      const order = state.subOrders.get(batch.issue)?.order;
      if (section === undefined || order === undefined) return [];
      const recorded = numberedEffects(
        state,
        (n) => siblingKey(batchId, n),
        SiblingResult,
        "a sibling section's revision",
      );
      const latest = recorded.at(-1);
      const digest = digestOf(section);
      if (latest?.section === digest) return [];
      const opened = subOrderPullRequests(state, order).filter(
        ({ pullRequest }) => pullRequest !== undefined,
      ).length;
      // A merged body is written again only to name a sibling that opened since: a blocker merges
      // before what waits for it opens (ADR 0211), and is its merge commit's description already.
      // One never revised, as one merged before ADR 0292, is left as it merged.
      if (end === 'merged' && (latest === undefined || latest.opened >= opened)) return [];
      const key = siblingKey(batchId, recorded.length + 1);
      due.set(effectKey.encode(key), { url, section, digest, opened });
      return [key];
    },
    target,
  };
};
