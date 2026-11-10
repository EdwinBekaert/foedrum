// What changed on a claimed issue after someone in `users` approved it (ADR 0368): its title, its
// body or a comment, after the latest adding of its intake label, or after the engineer's latest
// "continue". The driver checks it before each attempt of a claimed order starts, and asks the
// engineer when anything did; it never goes on by itself.

import { MOST_ORDER_CHANGES, type OrderChange } from '../schemas/events.ts';
import { isMarkedComment } from './claim-effects.ts';
import type { Batch } from './fold.ts';
import { type IntakeFilter, same } from './issue-claims.ts';

export type { OrderChange };

/** The one question a batch whose issue changed asks, which `foedrum answer` answers. */
export const ORDER_CHANGED_QUESTION =
  'The issue changed after it was approved: continue with it as it is now, or stop?';

/** What a claimed issue's history says of it, from GitHub; every time an ISO date. */
export interface OrderActivity {
  /** Each adding of a label, oldest first; `by` undefined for a deleted account. */
  labelled: readonly { label: string; by: string | undefined; at: string }[];
  /** Each change of its title. */
  renamed: readonly { by: string | undefined; at: string }[];
  /** Each edit of its body. */
  edited: readonly { by: string | undefined; at: string }[];
  /** Its comments, each with when it was made and last changed. */
  comments: readonly {
    id: number;
    by: string | undefined;
    association: string;
    created: string;
    updated: string;
    body: string;
  }[];
}

/** The changes to ask about, the first few, how many more, and the latest one's time. */
export interface OrderChanges {
  changes: OrderChange[];
  more: number;
  upTo: string;
}

/** The issue a claimed order brews, on GitHub, which every question about it links. */
export const issueUrl = (repo: string, issue: number): string =>
  `https://github.com/${repo}/issues/${issue}`;

/** What changed, as people read it: each change, who made it and when, and how many more. */
export const changesText = (
  { changes, more }: Pick<OrderChanges, 'changes' | 'more'>,
  shown: (login: string) => string = (login) => login,
): string => {
  const listed = changes.map((change) => {
    const what = change.what === 'comment' ? `comment ${change.comment}` : `the ${change.what}`;
    const by = change.by === undefined ? 'a deleted account' : shown(change.by);
    return `${what} by ${by} at ${change.at}`;
  });
  return `${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

export interface OrderCheckOptions {
  /** Reads a claimed issue's activity; rejects when it cannot. */
  activity: (repo: string, issue: number, signal?: AbortSignal) => Promise<OrderActivity>;
  /** The Brewery's `users`, who approve. */
  users: readonly string[];
  /** The Brewery's login, whose marked comments are Foedrum's own (ADR 0333). */
  login: string;
  /** The intake filter of a target repository, whose labels approve its issues (ADR 0359). */
  filterOf: (repo: string) => IntakeFilter | undefined;
}

/** What changed on `batch`'s claimed issue since it was approved; undefined when nothing did. */
export type OrderCheck = (batch: Batch, signal?: AbortSignal) => Promise<OrderChanges | undefined>;

const later = (one: string, other: string): boolean => Date.parse(one) > Date.parse(other);
const latest = (times: readonly (string | undefined)[]): string | undefined =>
  times.reduce<string | undefined>(
    (found, at) => (at !== undefined && (found === undefined || later(at, found)) ? at : found),
    undefined,
  );

/**
 * When `batch`'s issue was last approved, undefined when it never was: a person's order when they
 * made it; else the moment each of the filter's labels had been added by someone in `users`, at or
 * before the order, since a label added later approves nothing the order took; and after either,
 * the engineer's latest "continue", up to what it was shown.
 */
export const approvedAt = (
  batch: Batch,
  { labelled }: Pick<OrderActivity, 'labelled'>,
  filter: IntakeFilter | undefined,
  users: readonly string[],
): string | undefined => {
  const ordered = (): string | undefined => {
    if (batch.orderedBy !== undefined && batch.orderedAt !== undefined) return batch.orderedAt;
    const { orderedAt } = batch;
    const labels = filter?.labels ?? [];
    const each = labels.map((label) =>
      latest(
        labelled
          .filter(({ by }) => by !== undefined && users.some((user) => same(user, by)))
          .filter((added) => same(added.label, label))
          .filter(({ at }) => orderedAt === undefined || !later(at, orderedAt))
          .map(({ at }) => at),
      ),
    );
    if (labels.length === 0 || each.some((at) => at === undefined)) return undefined;
    return latest(each);
  };
  return latest([ordered(), batch.approvedUpTo]);
};

/**
 * The changes of `activity` after `since`, or every one when it is undefined: each change of the
 * title, each edit of the body, and each comment made or changed, by anyone but Foedrum, whose
 * comments are its login's that end in an effect marker (ADR 0333). The first few by time, how
 * many more, and the latest one's time; undefined when there is none.
 */
export const changesSince = (
  activity: OrderActivity,
  since: string | undefined,
  login: string,
): OrderChanges | undefined => {
  const after = ({ at }: { at: string }): boolean => since === undefined || later(at, since);
  const byOf = (by: string | undefined) => (by === undefined ? {} : { by });
  const foedrums = ({ by, body }: OrderActivity['comments'][number]): boolean =>
    by !== undefined && same(by, login) && isMarkedComment(body);
  const changes: OrderChange[] = [
    ...activity.renamed
      .filter(after)
      .map(({ by, at }) => ({ what: 'title' as const, ...byOf(by), at })),
    ...activity.edited
      .filter(after)
      .map(({ by, at }) => ({ what: 'body' as const, ...byOf(by), at })),
    ...activity.comments
      .filter((comment) => !foedrums(comment))
      .map(({ id, by, updated }) => ({
        what: 'comment' as const,
        comment: id,
        ...byOf(by),
        at: updated,
      }))
      .filter(after),
  ].sort((one, other) => Date.parse(one.at) - Date.parse(other.at));
  const upTo = changes.at(-1)?.at;
  if (upTo === undefined) return undefined;
  const shown = changes.slice(0, MOST_ORDER_CHANGES);
  return { changes: shown, more: changes.length - shown.length, upTo };
};

/**
 * The check the driver runs before each brewer attempt of a claimed order (ADR 0368): it reads the
 * issue's activity and gives what changed since its approval. A Brewery order is never checked:
 * no label approves it, and the Brewery is its users' own repository (ADR 0359).
 */
export const createOrderCheck =
  ({ activity, users, login, filterOf }: OrderCheckOptions): OrderCheck =>
  async (batch, signal) => {
    const { repo, issue } = batch;
    if (repo === undefined) return undefined;
    const read = await activity(repo, issue, signal);
    return changesSince(read, approvedAt(batch, read, filterOf(repo), users), login);
  };
