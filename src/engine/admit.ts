// The guard before append: refuses events the fold would throw on, and the lifecycle and bottling
// rules the fold leaves out (architecture §4.1, §4.3, ADR 0013, ADR 0025). Pure: no clock or I/O.

import type { Event } from '../schemas/events.ts';
import type { State } from './fold.ts';

/** What the command layer appends, or why it appends nothing. */
export type Decision =
  | { kind: 'accepted'; events: readonly Event[] }
  | { kind: 'refused'; reason: string };

/**
 * Accepts `events` when each one, folded onto `state` and the events before it, is valid and
 * allowed in its batch's lane; otherwise refuses all of them, naming the first refused event.
 */
export function admit(_state: State, _events: readonly Event[]): Decision {
  throw new Error('not implemented');
}
