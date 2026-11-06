// Since when a driver's passes fail on each batch (ADR 0335): one clock per batch across its passes,
// and one for its readings, which can hide a deadline, where an effect that fails cannot. It decides
// when a batch is marked, so it stays in the driver's memory, as the flush watch does (ADR 0027): a
// restart makes a mark later, never sooner.

import type { FailingPass } from '../schemas/events.ts';

/** How long a batch fails before it is marked, and brewing with a reading that fails Stuck. */
export const failingLimitMs = 3_600_000;

/** A batch past the limit: what failed last, and whether its readings have for as long. */
export interface OverLimit {
  batchId: string;
  pass: FailingPass;
  summary: string;
  since: string;
  reading: boolean;
}

interface Entry {
  since: number;
  readingSince?: number;
  pass: FailingPass;
  summary: string;
  again: boolean;
  readingAgain: boolean;
  marked: boolean;
}

export interface FailingBatches {
  /** Notes a failure of `batchId` in `pass`, a reading's unless an effect failed. */
  failed(batchId: string, pass: FailingPass, summary: string, reading: boolean, now: Date): void;
  /**
   * Ends a tick: forgets the batches that did not fail since the last, starts the clocks again of
   * a batch whose mark a person's command took off, and gives those past the limit.
   */
  settle(isMarked: (batchId: string) => boolean, now: Date): OverLimit[];
  /** Its mark is written, so its going means a person's command took it off. */
  marked(batchId: string): void;
  /** Whether `batchId` failed in the tick that `settle` ended last. */
  has(batchId: string): boolean;
}

export const createFailingBatches = (): FailingBatches => {
  const entries = new Map<string, Entry>();
  return {
    failed: (batchId, pass, summary, reading, now) => {
      const at = now.getTime();
      const entry: Entry = entries.get(batchId) ?? {
        since: at,
        pass,
        summary,
        again: true,
        readingAgain: false,
        marked: false,
      };
      entries.set(batchId, entry);
      entry.pass = pass;
      entry.summary = summary;
      entry.again = true;
      if (reading) {
        entry.readingSince ??= at;
        entry.readingAgain = true;
      }
    },
    settle: (isMarked, now) => {
      const at = now.getTime();
      const over: OverLimit[] = [];
      for (const [batchId, entry] of entries) {
        if (!entry.again) {
          entries.delete(batchId);
          continue;
        }
        if (!entry.readingAgain) delete entry.readingSince;
        entry.again = false;
        entry.readingAgain = false;
        const marked = isMarked(batchId);
        if (entry.marked && !marked) {
          entry.since = at;
          if (entry.readingSince !== undefined) entry.readingSince = at;
        }
        entry.marked = marked;
        if (at - entry.since < failingLimitMs) continue;
        const { since, readingSince, pass, summary } = entry;
        over.push({
          batchId,
          pass,
          summary,
          since: new Date(since).toISOString(),
          reading: readingSince !== undefined && at - readingSince >= failingLimitMs,
        });
      }
      return over;
    },
    marked: (batchId) => {
      const entry = entries.get(batchId);
      if (entry !== undefined) entry.marked = true;
    },
    has: (batchId) => entries.has(batchId),
  };
};
