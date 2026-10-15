// The canonical text of an effect key: the `key` of an `effect.applied` event and of the effects
// index. A JSON array, so no part can collide with a separator.

import type { EffectKey } from './event-store.ts';

export const effectKey = {
  /** The canonical text of `key`; throws when a part is invalid. */
  encode: (_key: EffectKey): string => {
    throw new Error('not implemented');
  },
  /** The key of a canonical text; throws for any other text, so one key has exactly one text. */
  decode: (_text: string): EffectKey => {
    throw new Error('not implemented');
  },
};
