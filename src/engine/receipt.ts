// An attempt's receipt as a person reads it (ADR 0172): one line per attempt where a batch is
// shown, and a batch's total. Cost is always an estimate: claude reports list prices.

import type { Receipt, Usage } from '../schemas/events.ts';
import type { Batch } from './fold.ts';

/**
 * A finished attempt's receipt, with the tokens its step.finished recorded. Its cost is the
 * attempt's own, unless `forSession` says it is its session's so far.
 */
export interface AttemptReceipt {
  stepId: string;
  attempt: number;
  receipt: Receipt;
  usage?: Usage;
  forSession?: true;
}

/**
 * The receipts of `batch`'s attempts, in the order they ran. A resumed run reports its session's
 * cost so far (ADR 0042): its own is that less the cost the session's receipt before it reported,
 * and without one in the batch it stays the session's.
 */
export function receiptsOf(batch: Batch): AttemptReceipt[] {
  // The cost each session reported last, by its id: a resumed session keeps it (ADR 0117).
  const sessionCost = new Map<string, number>();
  return (batch.path ?? []).flatMap(({ stepId, attempt }) => {
    const found = batch.steps.get(stepId)?.attempts.get(attempt);
    if (found?.phase !== 'finished' || found.receipt === undefined) return [];
    const { usage } = found;
    const session = found.session?.id;
    const reported = found.receipt.costUsd;
    const before = session === undefined ? undefined : sessionCost.get(session);
    if (session !== undefined && reported !== undefined) sessionCost.set(session, reported);
    const resumed = found.receipt.resumed === true && reported !== undefined;
    const receipt =
      resumed && before !== undefined
        ? { ...found.receipt, costUsd: Math.max(0, reported - before) }
        : found.receipt;
    return [
      {
        stepId,
        attempt,
        receipt,
        ...(usage === undefined ? {} : { usage }),
        ...(resumed && before === undefined ? { forSession: true as const } : {}),
      },
    ];
  });
}

const counted = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** `2m 38s`, `45s`, `1h 2m`. */
const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** `812 tokens`, `4.13k tokens`, `1.34M tokens`: three significant digits past a thousand. */
const tokens = (n: number): string => {
  if (n < 1000) return counted(n, 'token');
  // Rounded first: 999,600 is 1M, not 1000k.
  const thousands = Number((n / 1000).toPrecision(3));
  if (thousands < 1000) return `${thousands}k tokens`;
  return `${Number((n / 1_000_000).toPrecision(3))}M tokens`;
};

/** Always an estimate: on a subscription it is not what the user pays. */
const cost = (usd: number): string =>
  usd > 0 && usd < 0.005 ? '<$0.01 est.' : `$${usd.toFixed(2)} est.`;

const tokensOf = (usage: Usage): number =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

const deniedCount = (receipt: Receipt): number =>
  receipt.denied.reduce((sum, family) => sum + family.count, 0);

/**
 * The parts of one receipt's line: duration, turns, tokens, cost and denials, each left out when
 * there is nothing to show. `told` shows a text the stream gave: a tool's name, a refused prefix.
 */
export function receiptParts(
  receipt: Receipt,
  usage: Usage | undefined,
  told: (text: string) => string = (text) => text,
  forSession = false,
): string[] {
  const denied = deniedCount(receipt);
  const families = receipt.denied.map(({ tool, refused }) =>
    refused.length === 0 ? told(tool) : `${told(tool)}: ${refused.map(told).join(', ')}`,
  );
  return [
    ...(receipt.durationMs === undefined ? [] : [duration(receipt.durationMs)]),
    counted(receipt.turns, 'turn'),
    ...(usage === undefined ? [] : [tokens(tokensOf(usage))]),
    ...(receipt.costUsd === undefined
      ? []
      : [`${cost(receipt.costUsd)}${forSession ? ' for the session' : ''}`]),
    ...(denied === 0 ? [] : [`${denied} denied (${families.join('; ')})`]),
    ...(receipt.complete ? [] : ['incomplete']),
  ];
}

/** The parts of `batch`'s total over its attempts with a receipt; none when no attempt has one. */
export function totalParts(batch: Batch): string[] {
  const all = receiptsOf(batch);
  if (all.length === 0) return [];
  const sum = (of: (each: AttemptReceipt) => number | undefined): number =>
    all.reduce((total, each) => total + (of(each) ?? 0), 0);
  const timed = all.some(({ receipt }) => receipt.durationMs !== undefined);
  const priced = all.some(({ receipt }) => receipt.costUsd !== undefined);
  const used = all.some(({ usage }) => usage !== undefined);
  const denied = sum(({ receipt }) => deniedCount(receipt));
  return [
    counted(all.length, 'attempt'),
    ...(timed ? [duration(sum(({ receipt }) => receipt.durationMs))] : []),
    counted(
      sum(({ receipt }) => receipt.turns),
      'turn',
    ),
    ...(used ? [tokens(sum(({ usage }) => (usage === undefined ? 0 : tokensOf(usage))))] : []),
    ...(priced ? [cost(sum(({ receipt }) => receipt.costUsd))] : []),
    ...(denied === 0 ? [] : [`${denied} denied`]),
  ];
}
