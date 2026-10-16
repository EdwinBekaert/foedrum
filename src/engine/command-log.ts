// The one way the command layer appends (ADR 0019, ADR 0025): a command is decided against every
// event committed so far, inside the write transaction that appends its events, so a second writer
// on the same store (another driver, a terminal command) can never make it decide on a stale state.

import type { Decision } from './admit.ts';
import type { Command } from './decide.ts';
import type { EventStore, EventStoreTransaction } from './event-store.ts';
import type { State } from './fold.ts';
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

export interface CommandLog {
  /** The folded state of every event committed so far. */
  state(): State;
  /**
   * Decides `command` at `now` against every event committed so far and appends its events with
   * `also`'s writes, in one transaction. A refused command appends nothing and `also` does not run.
   */
  issue(command: Command, now: Date, also?: (tx: EventStoreTransaction) => void): Decision;
}

export const createCommandLog = (_options: CommandLogOptions): CommandLog => {
  throw new Error('not implemented');
};
