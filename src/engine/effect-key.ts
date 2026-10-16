// The canonical text of an effect key: the `key` of an `effect.applied` event and of the effects
// index. Validated by the schemas in src/schemas/store.ts.

import { EffectKey, EffectKeyParts, EffectKeyText } from '../schemas/store.ts';

const invalid = (detail: string): Error => new Error(`Invalid effect key: ${detail}`);

const encode = (key: EffectKey): string => {
  if (!('stepId' in key)) throw new Error('not implemented');
  // Only the four parts: a key built by spreading a larger object may carry other fields.
  const { batchId, stepId, attempt, effect } = key;
  if (!EffectKey.safeParse({ batchId, stepId, attempt, effect }).success) {
    throw invalid(JSON.stringify(key));
  }
  return JSON.stringify([batchId, stepId, attempt, effect]);
};

const decode = (text: string): EffectKey => {
  if (!EffectKeyText.safeParse(text).success) {
    throw invalid(`${text} is not a canonical [batchId, stepId, attempt, effect]`);
  }
  const [batchId, stepId, attempt, effect] = EffectKeyParts.parse(JSON.parse(text));
  return { batchId, stepId, attempt, effect };
};

export const effectKey = {
  /** The canonical text of `key`; throws when a part is invalid. */
  encode,
  /** The key of a canonical text; throws for any other text, so one key has exactly one text. */
  decode,
};
