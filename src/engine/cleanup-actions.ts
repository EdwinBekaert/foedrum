// The Cellarer's jobs (ADR 0380), which the driver runs itself through the ledger, as an action:
// `shelve` forgets every finished batch and has the next flush move its folder to `archive/`,
// `sweep` removes what nothing changed in for 2 days from the Brewery's temporary folder, and
// `expire` has the next flush delete the shelf's months older than 6 months.

import { CellarerOutput } from '../schemas/cellarer.ts';
import type { CellarerJob } from '../schemas/recipe.ts';
import type { EffectKey } from '../schemas/store.ts';
import { type ArchiveFacts, archivable } from './archive.ts';
import { type AttemptRef, attemptKey } from './attempt-key.ts';
import type { CommandLog } from './command-log.ts';
import type { Ending } from './decide.ts';
import type { DriverActions, DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EventStore } from './event-store.ts';
import type { State } from './fold.ts';
import type { RecipeAction, Recipes } from './recipes.ts';
import { sweepTemp } from './temp-sweep.ts';

export interface CleanupActionsOptions {
  recipes: Recipes;
  /** The fold the jobs read, and the store they forget batches in. */
  log: CommandLog;
  store: Pick<EventStore, 'withTransaction'>;
  /** What the shelve reads beside the fold: effects still due, leases and what is not pushed. */
  facts: (state: State) => ArchiveFacts;
  /** The Brewery's temporary folder, `.foedrum/tmp/` in its clone. */
  temp: string;
  clock: () => Date;
}

/** How many months the shelf keeps a month of shelved batches before expire deletes it. */
const SHELF_MONTHS = 6;

/** `now`'s month in UTC, as `YYYY-MM`: the shelf a shelve puts its batches on. */
const monthOf = (now: Date): string => now.toISOString().slice(0, 7);

/** The month `SHELF_MONTHS` before `now`'s: expire deletes every month of the shelf before it. */
const expiryOf = (now: Date): string =>
  monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - SHELF_MONTHS, 1)));

/** The action `ref`'s step is in the recipe its batch brews, when it is one. */
const actionOf = (state: State, recipes: Recipes, ref: AttemptRef): RecipeAction | undefined => {
  const name = state.batches.get(ref.batchId)?.recipe?.name;
  const recipe = name === undefined ? undefined : recipes.find(name);
  return recipe?.has(ref.stepId) === true ? recipe.action(ref.stepId) : undefined;
};

/** The one effect of a Cellarer's attempt, named for its job. */
const keyOf = (ref: AttemptRef, job: CellarerJob): EffectKey => ({ ...ref, effect: job });

export const cleanupActions = (options: CleanupActionsOptions): DriverActions => {
  const { recipes, log, store, facts, temp, clock } = options;
  const jobOf = (state: State, ref: AttemptRef): CellarerJob | undefined => {
    const action = actionOf(state, recipes, ref);
    return action === 'openPullRequest' ? undefined : action;
  };
  const run = async (job: CellarerJob, key: EffectKey): Promise<CellarerOutput> => {
    const now = clock();
    switch (job) {
      case 'shelve': {
        const state = log.state();
        // Its own batch brews, so it is never one it takes.
        const batches = archivable(state, facts(state))
          .map(({ id }) => id)
          .filter((id) => id !== key.batchId);
        store.withTransaction((tx) => tx.forget(batches, { month: monthOf(now) }));
        return { cellarer: 'shelve', batches };
      }
      case 'sweep':
        return { cellarer: 'sweep', ...(await sweepTemp(temp, now)) };
      case 'expire': {
        const before = expiryOf(now);
        store.withTransaction((tx) => tx.expire(before));
        return { cellarer: 'expire', before };
      }
      default: {
        const unknown: never = job;
        throw new Error(`Unknown job of the Cellarer: ${String(unknown)}`);
      }
    }
  };
  return {
    due: (state, ref) => {
      const job = jobOf(state, ref);
      return job === undefined ? [] : [keyOf(ref, job)];
    },
    target: {
      // Nothing outside the store shows a job was done: the ledger is where it is found.
      find: async () => undefined,
      apply: async (encoded) => {
        const key = effectKey.decode(encoded);
        const job = 'stepId' in key ? key.effect : undefined;
        if (job !== 'shelve' && job !== 'sweep' && job !== 'expire') {
          throw new Error(`No job of the Cellarer is ${encoded}`);
        }
        return run(job, key);
      },
    },
    ending: (state, ref): Ending => {
      const job = jobOf(state, ref);
      const recorded =
        job === undefined ? undefined : state.effects.get(effectKey.encode(keyOf(ref, job)));
      const output = CellarerOutput.safeParse(recorded);
      return output.success
        ? { kind: 'succeeded', output: output.data }
        : {
            kind: 'failed',
            retryable: true,
            reason: `the ledger has no result of the Cellarer's ${job ?? 'job'} at step ${ref.stepId}`,
          };
    },
  };
};

/**
 * One set of actions out of several, by the action each attempt's step is in its recipe: what the
 * driver runs for a pull request's step and for the Cellarer's.
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

/**
 * What the shelve reads beside the fold, from the driver's sources and its store: a batch has an
 * effect due while a key a source gives is not in the ledger, or a source throws; it is leased
 * while it or one of its attempts has a live lease; and it is not pushed while the state branch
 * lacks one of its events or the store still keeps an out doc of it.
 */
export const storeFacts =
  (
    effects: Pick<DriverEffects, 'due'>,
    store: Pick<
      EventStore,
      | 'findEffect'
      | 'batchLeases'
      | 'currentLeases'
      | 'pushedThrough'
      | 'lastEventOf'
      | 'keptOutDocs'
    >,
    clock: () => Date,
  ) =>
  (state: State): ArchiveFacts => {
    const now = clock();
    const pushed = store.pushedThrough()?.eventId ?? 0;
    const kept = new Set(store.keptOutDocs().map(({ batchId }) => batchId));
    return {
      due: (batchId) => {
        try {
          return effects.due(state, batchId).some((key) => store.findEffect(key) === undefined);
        } catch {
          return true;
        }
      },
      leased: new Set([
        ...store.batchLeases(now).map(({ batchId }) => batchId),
        ...store
          .currentLeases(now)
          .flatMap(({ attemptKey: key }) => attemptKey.decode(key)?.batchId ?? []),
      ]),
      unpushed: (batchId) => kept.has(batchId) || (store.lastEventOf(batchId) ?? 0) > pushed,
    };
  };
