// The canonical text of an effect key: the `key` of an `effect.applied` event and of the effects
// index. Validated by the schemas in src/schemas/store.ts.

import {
  type AttemptEffectKey,
  type BatchEffectKey,
  type EffectKey,
  EffectKeyParts,
  EffectKeyText,
} from '../schemas/store.ts';
import type { z } from '../schemas/zod.ts';
import type { State } from './fold.ts';

const invalid = (detail: string): Error => new Error(`Invalid effect key: ${detail}`);

const encode = (key: EffectKey): string => {
  // Only the key's own parts: a key built by spreading a larger object may carry other fields.
  // A key with either of a step and an attempt is an attempt's, so one without the other fails.
  const { batchId, effect } = key;
  const { stepId, attempt } = key as Partial<AttemptEffectKey>;
  const parts =
    stepId === undefined && attempt === undefined
      ? [batchId, effect]
      : [batchId, stepId, attempt, effect];
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

/**
 * What the ledger recorded for the numbered effects of a batch, `keyOf(1)`, `keyOf(2)` and on, as
 * far as they go: each is due only after the one before, so the first not recorded ends them.
 * Throws for a recorded result that `schema` does not take, naming it `what`.
 */
export const numberedEffects = <T>(
  state: State,
  keyOf: (n: number) => BatchEffectKey,
  schema: z.ZodType<T>,
  what: string,
): T[] => {
  const recorded: T[] = [];
  for (let n = 1; ; n++) {
    const key = encode(keyOf(n));
    if (!state.effects.has(key)) return recorded;
    const parsed = schema.safeParse(state.effects.get(key));
    if (!parsed.success) throw new Error(`The ledger's ${key} is not ${what}`);
    recorded.push(parsed.data);
  }
};
