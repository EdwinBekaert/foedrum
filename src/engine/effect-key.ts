// The canonical text of an effect key: the `key` of an `effect.applied` event and of the effects
// index. A JSON array, so no part can collide with a separator.

import type { EffectKey } from './event-store.ts';

const isPart = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isAttempt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const invalid = (detail: string): Error => new Error(`Invalid effect key: ${detail}`);

const encode = (key: EffectKey): string => {
  const { batchId, stepId, attempt, effect } = key;
  if (!isPart(batchId) || !isPart(stepId) || !isAttempt(attempt) || !isPart(effect)) {
    throw invalid(JSON.stringify(key));
  }
  return JSON.stringify([batchId, stepId, attempt, effect]);
};

const decode = (text: string): EffectKey => {
  let parts: unknown;
  try {
    parts = JSON.parse(text);
  } catch {
    throw invalid(`${text} is not JSON`);
  }
  if (!Array.isArray(parts) || parts.length !== 4) {
    throw invalid(`${text} is not [batchId, stepId, attempt, effect]`);
  }
  const [batchId, stepId, attempt, effect] = parts as unknown[];
  if (!isPart(batchId) || !isPart(stepId) || !isAttempt(attempt) || !isPart(effect)) {
    throw invalid(`${text} has an invalid part`);
  }
  const key = { batchId, stepId, attempt, effect };
  // One key, one text: otherwise two spellings of a key would both pass the UNIQUE index.
  if (encode(key) !== text) throw invalid(`${text} is not in canonical form`);
  return key;
};

export const effectKey = {
  /** The canonical text of `key`; throws when a part is invalid. */
  encode,
  /** The key of a canonical text; throws for any other text, so one key has exactly one text. */
  decode,
};
