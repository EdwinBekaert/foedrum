// An attempt's receipt as a person reads it (ADR 0172): one line per attempt where a batch is
// shown, and a batch's total. Cost is always an estimate: claude reports list prices.

import type { Receipt, Usage } from '../schemas/events.ts';
import type { Batch } from './fold.ts';

/** A finished attempt's receipt, with the tokens its step.finished recorded. */
export interface AttemptReceipt {
  stepId: string;
  attempt: number;
  receipt: Receipt;
  usage?: Usage;
}

/** The receipts of `batch`'s attempts, in the order they ran. */
export function receiptsOf(_batch: Batch): AttemptReceipt[] {
  throw new Error('not implemented');
}

/**
 * The parts of one receipt's line: duration, turns, tokens, cost and denials. `told` shows a text
 * the stream gave, a refused command's prefix.
 */
export function receiptParts(
  _receipt: Receipt,
  _usage: Usage | undefined,
  _told: (text: string) => string = (text) => text,
): string[] {
  throw new Error('not implemented');
}

/** The parts of `batch`'s total over its attempts with a receipt; none when no attempt has one. */
export function totalParts(_batch: Batch): string[] {
  throw new Error('not implemented');
}
