// What changed on a claimed issue after someone in `users` approved it (ADR 0368): its title, its
// body or a comment, after the latest adding of its intake label, or after the engineer's latest
// "continue". The driver checks it before each attempt of a claimed order starts, and asks the
// engineer when anything did; it never goes on by itself.

import type { Batch } from './fold.ts';
import type { IntakeFilter } from './issue-claims.ts';

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

/** A change after the approval: the title, the body, or a comment made or edited. */
export type OrderChange =
  | { what: 'title' | 'body'; by?: string; at: string }
  | { what: 'comment'; comment: number; by?: string; at: string };

/** The changes to ask about, the first few, how many more, and the latest one's time. */
export interface OrderChanges {
  changes: OrderChange[];
  more: number;
  upTo: string;
}

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

export const createOrderCheck = (_options: OrderCheckOptions): OrderCheck => {
  throw new Error('not implemented');
};
