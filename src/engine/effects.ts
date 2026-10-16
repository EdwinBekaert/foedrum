// Applying an external side effect through the idempotency ledger (invariant I4, ADR 0032).

import type { EffectKey } from './event-store.ts';

/** Where an effect lands (a pull request, a comment, a label on the code host). */
export interface EffectTarget {
  /** The result of the effect with this key when the target already has it, found by its key. */
  find(key: string): Promise<{ result: unknown } | undefined>;
  /** Applies the effect, carrying its key so that `find` sees it; returns its result. */
  apply(key: string): Promise<unknown>;
}

/** The idempotency ledger: the `effect.applied` events of the store. */
export interface Ledger {
  find(key: EffectKey): { result: unknown } | undefined;
  /** Appends the `effect.applied` event of `key`. */
  record(key: EffectKey, result: unknown): void;
}

/** How an effect's result was had: from the ledger, found on the target, or applied now. */
export type Applied = { result: unknown; via: 'ledger' | 'found' | 'applied' };

export const applyEffect = async (
  _ledger: Ledger,
  _key: EffectKey,
  _target: EffectTarget,
): Promise<Applied> => {
  throw new Error('not implemented');
};
