// Pauses (ADR 0202): which batches a person's pause holds, and when what runs of them is stopped.

import type { OrderRef } from '../schemas/events.ts';
import { type Batch, orderKey, type Pause, type State } from './fold.ts';

/** The order `batch` brews for: its own issue, or for a sub-order's batch its order's. */
export const orderOfBatch = (state: State, batch: Batch): OrderRef => {
  const { issue, repo } = batch;
  if (repo !== undefined) return { issue, repo };
  return { issue: state.subOrders.get(issue)?.order ?? issue };
};

/**
 * The pause that holds `batch`, if any: `--all`, else its order's (a sub-order's batch is held by
 * its order's), with the earlier stopAt of the two. A batch that ended is held by none.
 */
export const pauseOf = (state: State, batch: Batch): Pause | undefined => {
  if (batch.lane.kind === 'on_tap' || batch.lane.kind === 'cancelled') return undefined;
  const { all } = state.pauses;
  const own = state.pauses.orders.get(orderKey(orderOfBatch(state, batch)));
  if (all === undefined || own?.stopAt === undefined) return all ?? own;
  // Under --all an order's own --by still stops it, when it comes first.
  const { stopAt: _, ...rest } = all;
  const earlier =
    all.stopAt === undefined || Date.parse(own.stopAt.at) < Date.parse(all.stopAt.at)
      ? own.stopAt
      : all.stopAt;
  return { ...rest, stopAt: earlier };
};

/** Whether the pause holding `batch` has reached its stopAt at `now`: what runs of it is stopped. */
export const stopsNow = (state: State, batch: Batch, now: Date): boolean => {
  const at = pauseOf(state, batch)?.stopAt?.at;
  return at !== undefined && Date.parse(at) <= now.getTime();
};

const clockOf = (at: Date, zone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);

/**
 * When what runs is stopped, in UTC with the time and day in the zone it was given in:
 * `16:30 UTC (17:30 Europe/Brussels, 18 October)` (ADR 0202).
 */
export const stopAtText = ({ at, zone }: NonNullable<Pause['stopAt']>): string => {
  const instant = new Date(at);
  const utc = `${clockOf(instant, 'UTC')} UTC`;
  // The zone was recorded on the machine that paused: the one folding the log may not know it.
  let local: string;
  try {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'long' });
    local = `${clockOf(instant, zone)} ${zone}, ${day.format(instant)}`;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    local = zone;
  }
  return `${utc} (${local})`;
};
