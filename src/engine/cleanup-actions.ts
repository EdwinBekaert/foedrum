// The actions of a cleanup recipe (ADR 0380), which the driver runs itself through the ledger:
// `archive` records `batch.archived` for every batch the cleanup may take, and `sweep` removes what
// nothing changed in for 2 days from the Brewery's temporary folder.

import type { EffectKey } from '../schemas/store.ts';
import { z } from '../schemas/zod.ts';
import { type ArchiveFacts, archivable, archivedOf } from './archive.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { CommandLog } from './command-log.ts';
import type { Ending } from './decide.ts';
import type { DriverActions, DriverEffects } from './driver.ts';
import type { EventStore } from './event-store.ts';
import { effectKey } from './effect-key.ts';
import type { State } from './fold.ts';
import type { RecipeAction, Recipes } from './recipes.ts';
import { sweepTemp } from './temp-sweep.ts';

export interface CleanupActionsOptions {
  recipes: Recipes;
  /** Records the archive's events, in the store the driver reads. */
  log: CommandLog;
  /** What the archive reads beside the fold: effects still due and leases. */
  facts: (state: State) => ArchiveFacts;
  /** The Brewery's temporary folder, `.foedrum/tmp/` in its clone. */
  temp: string;
  clock: () => Date;
}

/** The action `ref`'s step is in the recipe its batch brews, when it is one. */
const actionOf = (state: State, recipes: Recipes, ref: AttemptRef): RecipeAction | undefined => {
  const name = state.batches.get(ref.batchId)?.recipe?.name;
  const recipe = name === undefined ? undefined : recipes.find(name);
  return recipe?.has(ref.stepId) === true ? recipe.action(ref.stepId) : undefined;
};

/** What the ledger keeps of an archive or a sweep, as its attempt's output. */
const CleanupResult = z.union([
  z.strictObject({ archived: z.array(z.string()) }),
  z.strictObject({
    removed: z.array(z.string()),
    failed: z.array(z.strictObject({ name: z.string(), error: z.string() })),
  }),
]);

/** The one effect of a cleanup action's attempt, named for its action. */
const keyOf = (ref: AttemptRef, effect: 'archive' | 'sweep'): EffectKey => ({ ...ref, effect });

/**
 * What the archive reads beside the fold, from the driver's sources and its store (ADR 0380): a
 * batch has an effect due while a key a source gives is not in the ledger, or a source throws;
 * and a batch is leased while it, or one of its attempts, has a live lease.
 */
export const storeFacts =
  (
    _effects: Pick<DriverEffects, 'due'>,
    _store: Pick<EventStore, 'findEffect' | 'batchLeases' | 'currentLeases'>,
    _clock: () => Date,
  ) =>
  (_state: State): ArchiveFacts => {
    throw new Error('not implemented');
  };

export const cleanupActions = (options: CleanupActionsOptions): DriverActions => {
  const { recipes, log, facts, temp, clock } = options;
  const cleanup = (state: State, ref: AttemptRef): 'archive' | 'sweep' | undefined => {
    const action = actionOf(state, recipes, ref);
    return action === 'archive' || action === 'sweep' ? action : undefined;
  };
  const archive = async (key: EffectKey): Promise<{ archived: string[] }> => {
    const archived: string[] = [];
    const state = log.state();
    // Its own batch brews, so it is never one it takes.
    for (const batch of archivable(state, facts(state))) {
      if (batch.id === key.batchId) continue;
      const decision = log.issue(
        { kind: 'record', event: archivedOf(log.state(), batch) },
        clock(),
      );
      if (decision.kind === 'accepted') archived.push(batch.id);
    }
    return { archived };
  };
  return {
    due: (state, ref) => {
      const action = cleanup(state, ref);
      return action === undefined ? [] : [keyOf(ref, action)];
    },
    target: {
      // Nothing outside the store shows either was done: the ledger is where it is found.
      find: async () => undefined,
      apply: async (encoded) => {
        const key = effectKey.decode(encoded);
        if (!('stepId' in key)) throw new Error(`No cleanup effect ${encoded}`);
        return key.effect === 'archive' ? archive(key) : sweepTemp(temp, clock());
      },
    },
    ending: (state, ref): Ending => {
      const action = cleanup(state, ref);
      const recorded =
        action === undefined ? undefined : state.effects.get(effectKey.encode(keyOf(ref, action)));
      const result = CleanupResult.safeParse(recorded);
      return result.success
        ? { kind: 'succeeded', output: result.data }
        : {
            kind: 'failed',
            retryable: true,
            reason: `the ledger has no ${action ?? 'cleanup'} result of step ${ref.stepId}`,
          };
    },
  };
};

/**
 * One set of actions out of several, by the action each attempt's step is in its recipe: what the
 * driver runs for a pull request's step and for a cleanup's (ADR 0380).
 */
export const actionsByKind = (
  recipes: Recipes,
  kinds: Partial<Record<RecipeAction, DriverActions>>,
): DriverActions => {
  // The actions behind each key `due` gave; the driver asks `due` before it applies a key.
  const owners = new Map<string, DriverActions>();
  const ownerOf = (state: State, ref: AttemptRef): DriverActions | undefined => {
    const action = actionOf(state, recipes, ref);
    return action === undefined ? undefined : kinds[action];
  };
  const targetOf = (key: string): DriverActions => {
    const found = owners.get(key);
    if (found === undefined) throw new Error(`No action effect ${key} is due`);
    return found;
  };
  return {
    due: (state, ref) => {
      const owner = ownerOf(state, ref);
      if (owner === undefined) return [];
      const keys = owner.due(state, ref);
      for (const key of keys) owners.set(effectKey.encode(key), owner);
      return keys;
    },
    target: {
      find: (key, signal) => targetOf(key).target.find(key, signal),
      apply: (key, signal) => targetOf(key).target.apply(key, signal),
    },
    ending: (state, ref) =>
      ownerOf(state, ref)?.ending(state, ref) ?? {
        kind: 'failed',
        retryable: false,
        reason: `no action runs step ${ref.stepId}`,
      },
  };
};
