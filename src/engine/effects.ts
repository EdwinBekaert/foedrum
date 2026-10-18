// Applying an external side effect through the idempotency ledger (invariant I4, ADR 0033).

import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectKey } from './event-store.ts';

/**
 * Where an effect lands (a pull request, a comment, a label on the code host). Its results are
 * checked against the effect's schema before it returns them: they come from outside the process,
 * and the ledger keeps them for good. Both calls stop what they do on the code host when `signal`
 * aborts: the driver aborts an effect at its deadline, below the batch lease (ADR 0044, #130).
 */
export interface EffectTarget {
  /**
   * The result of the effect with this key when the target already has it, found by its key. Only
   * what Foedrum's own identity made counts (its comments and pull requests, branches in its own
   * repositories, never a fork's): keys are predictable, and anyone who can comment could plant one.
   */
  find(key: string, signal?: AbortSignal): Promise<{ result: unknown } | undefined>;
  /** Applies the effect, carrying its key so that `find` sees it; returns its result. */
  apply(key: string, signal?: AbortSignal): Promise<unknown>;
}

/** The idempotency ledger: the `effect.applied` events of the store. */
export interface Ledger {
  find(key: EffectKey): { result: unknown } | undefined;
  /** Appends the `effect.applied` event of `key`. */
  record(key: EffectKey, result: unknown): void;
}

/** How an effect's result was had: from the ledger, found on the target, or applied now. */
export type Applied = { result: unknown; via: 'ledger' | 'found' | 'applied' };

/**
 * Applies the effect of `key` at most once: the ledger's result when it is recorded, else the
 * target's when a run before applied it and was killed before recording it, else the result of
 * applying it now. Whatever the target answered is recorded; nothing is recorded when it fails.
 * Calls for one key must not overlap: both would find nothing and apply it. `signal` goes to the
 * target; once it aborts, nothing more is asked or recorded (#130).
 */
export const applyEffect = async (
  ledger: Ledger,
  key: EffectKey,
  target: EffectTarget,
  signal?: AbortSignal,
): Promise<Applied> => {
  const text = effectKey.encode(key);
  const recorded = ledger.find(key);
  if (recorded !== undefined) return { result: recorded.result, via: 'ledger' };
  signal?.throwIfAborted();
  const found = await target.find(text, signal);
  signal?.throwIfAborted();
  const applied: Applied =
    found === undefined
      ? { result: await target.apply(text, signal), via: 'applied' }
      : { result: found.result, via: 'found' };
  // Given up at its deadline: whether it landed is for the next pass's `find` to say.
  signal?.throwIfAborted();
  ledger.record(key, applied.result);
  return applied;
};

/**
 * The effects of every source together (ADR 0072): the keys each gives, and each key applied by
 * the source that gave it. The shortest deadline of theirs holds for all, the driver's when none
 * sets one.
 */
export const combineEffects = (...sources: readonly DriverEffects[]): DriverEffects => {
  // The source behind each key `due` gave; the driver asks `due` before it applies a key.
  const owners = new Map<string, DriverEffects>();
  const ownerOf = (key: string): DriverEffects => {
    const owner = owners.get(key);
    if (owner === undefined) throw new Error(`No effect ${key} is due`);
    return owner;
  };
  const deadlines = sources.flatMap(({ deadlineMs }) =>
    deadlineMs === undefined ? [] : [deadlineMs],
  );
  return {
    due: (state, batchId) =>
      sources.flatMap((source) => {
        const keys = source.due(state, batchId);
        for (const key of keys) owners.set(effectKey.encode(key), source);
        return keys;
      }),
    target: {
      find: async (key, signal) => ownerOf(key).target.find(key, signal),
      apply: async (key, signal) => ownerOf(key).target.apply(key, signal),
    },
    ...(deadlines.length === 0 ? {} : { deadlineMs: Math.min(...deadlines) }),
  };
};
