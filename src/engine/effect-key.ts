// The canonical text of an effect key: the `key` of an `effect.applied` event and of the effects
// index. Validated by the schemas in src/schemas/store.ts.

import { type EffectKey, EffectKeyParts, EffectKeyText } from '../schemas/store.ts';

const invalid = (detail: string): Error => new Error(`Invalid effect key: ${detail}`);

const encode = (key: EffectKey): string => {
  // Only the key's own parts: a key built by spreading a larger object may carry other fields.
  const parts =
    'stepId' in key
      ? [key.batchId, key.stepId, key.attempt, key.effect]
      : [key.batchId, key.effect];
  if (!EffectKeyParts.safeParse(parts).success) throw invalid(JSON.stringify(key));
  return JSON.stringify(parts);
};

const decode = (text: string): EffectKey => {
  if (!EffectKeyText.safeParse(text).success) {
    throw invalid(
      `${text} is not a canonical [batchId, stepId, attempt, effect] or [batchId, effect]`,
    );
  }
  const parts = EffectKeyParts.parse(JSON.parse(text));
  if (parts.length === 2) return { batchId: parts[0], effect: parts[1] };
  const [batchId, stepId, attempt, effect] = parts;
  return { batchId, stepId, attempt, effect };
};

export const effectKey = {
  /** The canonical text of `key`; throws when a part is invalid. */
  encode,
  /** The key of a canonical text; throws for any other text, so one key has exactly one text. */
  decode,
};
