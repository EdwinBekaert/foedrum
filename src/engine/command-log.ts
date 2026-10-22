// The one way the command layer appends (ADR 0019, ADR 0025): a command is decided against every
// event committed so far, inside the write transaction that appends its events, so a second writer
// on the same store (another driver, a terminal command) can never make it decide on a stale state.

import type { Decision } from './admit.ts';
import { type Command, decide } from './decide.ts';
import type { EventStore, EventStoreTransaction } from './event-store.ts';
import { emptyState, fold, type State } from './fold.ts';
import type { Recipes } from './recipes.ts';

/** Time between Conditioning and Stuck reminders: 2 days (architecture §4.3). */
export const defaultReminderMs = 2 * 24 * 3_600_000;
/** How long an Ordered batch may wait to be routed: 1 hour (ADR 0032). */
export const defaultRoutingMs = 3_600_000;

export interface CommandLogOptions {
  store: EventStore;
  recipes: Recipes;
  /** Default `defaultReminderMs`. */
  reminderMs?: number;
  /** Default `defaultRoutingMs`. */
  routingMs?: number;
}

/**
 * A command, or what makes one from the reads of the transaction that appends it, such as a batch
 * lease (ADR 0124): the command, or why there is none.
 */
export type Issuable = Command | ((tx: EventStoreTransaction) => Command | { refused: string });

export interface CommandLog {
  /** The folded state of every event committed so far. */
  state(): State;
  /**
   * Decides `command` at `now` against every event committed so far and appends its events with
   * `also`'s writes, in one transaction. A refused command appends nothing and `also` does not run.
   */
  issue(command: Issuable, now: Date, also?: (tx: EventStoreTransaction) => void): Decision;
}

export const createCommandLog = (options: CommandLogOptions): CommandLog => {
  const { store, recipes, reminderMs = defaultReminderMs, routingMs = defaultRoutingMs } = options;
  // The folded state, caught up with whatever was committed since it was last read.
  let folded = { state: emptyState, lastId: 0 };
  const state = (): State => {
    const stored = store.eventsAfter(folded.lastId);
    if (stored.length === 0) return folded.state;
    folded = {
      state: fold(
        stored.map(({ event }) => event),
        folded.state,
      ),
      lastId: stored.at(-1)?.id ?? folded.lastId,
    };
    return folded.state;
  };

  const issue = (
    command: Issuable,
    now: Date,
    also: (tx: EventStoreTransaction) => void = () => {},
  ): Decision => {
    // The write transaction holds the store's write lock from its start, so what it reads first
    // is every committed event, and nothing else is appended before its own events.
    if (typeof command === 'function') throw new Error('not implemented');
    return store.withTransaction((tx) => {
      const decided = decide(state(), command, { now, recipes, reminderMs, routingMs });
      if (decided.kind === 'accepted') {
        for (const event of decided.events) tx.append(event);
        also(tx);
      }
      return decided;
    });
  };

  return { state, issue };
};
