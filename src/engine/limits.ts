// The limits on what the intake starts (ADR 0217), beside the Brewery's `concurrency` (ADR 0068):
// a recipe's `concurrency`, the Brewery's open-order limit, and the touches limit: a sub-order
// whose `touches` overlap those of one that brews waits (ADR 0257). Pure: a function of the folded
// state, the pass's listing of the Brewery's issues and the limits, so a restart holds the same.

import { breweryIssueOf, orderName } from './claim-orders.ts';
import { type Batch, orderKey, type State } from './fold.ts';
import { recipeLabels } from './intake.ts';
import type { TargetIssue } from './issue-claims.ts';
import { orderOfBatch } from './pauses.ts';
import { hasSubOrdersLeft, type QueuedOrder } from './ranks.ts';
import { readySubOrders } from './ready-set.ts';
import type { Recipes } from './recipes.ts';
import { sameRepo } from './task-tree.ts';

/** Three orders in progress at once, by default (decided by the maintainer, 2026-10-26). */
export const DEFAULT_OPEN_ORDERS = 3;

/** What holds what the intake starts, besides the Brewery's free capacity. */
export interface Limits {
  /** How many orders may be open at once: `openOrders` in foedrum.jsonc. */
  openOrders: number;
  /** The `concurrency` of the recipe called `name`, or undefined when it has none. */
  recipe(name: string): number | undefined;
}

/** Why the intake does not start an entry of its queue now, or route a batch. */
export type Hold =
  | { kind: 'recipe'; recipe: string; limit: number }
  | { kind: 'open_orders'; limit: number }
  /** The sub-order `holder` brews, and its touches overlap the held sub-order's. */
  | { kind: 'touches'; holder: number };

/** The limits of `openOrders` and the recipes' own `concurrency`. */
export const limitsOf = (openOrders: number, recipes: Recipes): Limits => ({
  openOrders,
  recipe: (name) => recipes.find(name)?.concurrency,
});

const LIVE: ReadonlySet<Batch['lane']['kind']> = new Set([
  'ordered',
  'brewing',
  'conditioning',
  'stuck',
]);

/**
 * Whether a limit can hold now: some order is open, which every batch Ordered, Brewing,
 * Conditioning or Stuck makes its own.
 */
export const mayHold = (state: State): boolean => openOrders(state).size > 0;

/**
 * The open orders (ADR 0217), by `orderKey` in the order their batches were ordered, each with its
 * name as `foedrum status` gives it: a
 * batch of it, its own or a sub-order's, is Ordered, Brewing, Conditioning or Stuck, or a sub-order
 * of its latest breakdown has no batch yet while its latest batch is not cancelled.
 */
export const openOrders = (state: State): Map<string, string> => {
  const open = new Map<string, string>();
  for (const batch of state.batches.values()) {
    if (!LIVE.has(batch.lane.kind)) continue;
    const order = orderOfBatch(state, batch);
    const key = orderKey(order);
    if (open.has(key)) continue;
    // A sub-order's batch is named by its order, a claimed batch as status names it.
    open.set(key, order.repo === undefined ? `#${order.issue}` : orderName(state, batch));
  }
  for (const { issue, batchIds } of state.orders.values()) {
    const latest = state.batches.get(batchIds.at(-1) ?? '');
    if (latest === undefined || latest.lane.kind === 'cancelled') continue;
    const key = orderKey({ issue });
    if (!open.has(key) && hasSubOrdersLeft(state, { issue })) open.set(key, `#${issue}`);
  }
  return open;
};

/** A sub-order with the paths its plan touches, in the repository it writes in. */
interface Touching {
  issue: number;
  repo: string;
  touches: readonly string[];
}

const touchingOf = (state: State, issue: number): Touching | undefined => {
  const subOrder = state.subOrders.get(issue);
  const touches = subOrder?.touches;
  return subOrder === undefined || touches === undefined
    ? undefined
    : { issue, repo: subOrder.repo, touches };
};

const under = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);

/** Whether two sub-orders share a path, or one a path under a folder the other touches. */
const overlap = (one: Touching, other: Touching): boolean =>
  sameRepo(one.repo, other.repo) &&
  one.touches.some((a) => other.touches.some((b) => under(a, b) || under(b, a)));

/** The sub-orders with touches that have a batch Brewing, with that batch's id. */
const brewingTouching = (state: State): { subOrder: Touching; batchId: string }[] =>
  [...state.subOrders.values()].flatMap(({ issue, batchIds }) => {
    const subOrder = touchingOf(state, issue);
    const batchId = batchIds.find((id) => state.batches.get(id)?.lane.kind === 'brewing');
    return subOrder === undefined || batchId === undefined ? [] : [{ subOrder, batchId }];
  });

/** The one recipe an issue's labels name, or undefined for none or more than one. */
const oneRecipe = (labels: readonly string[]): string | undefined => {
  const names = recipeLabels(labels);
  return names.length === 1 ? names[0] : undefined;
};

/** What a walk of the queue started so far, and what holds its next entry. */
export interface StartTally {
  /** The limit that holds `entry` now, or undefined when it may start. */
  hold(entry: QueuedOrder): Hold | undefined;
  /** Counts `entry` as started. */
  start(entry: QueuedOrder): void;
}

/** Each recipe's batches Brewing, by name, in the order they were ordered. */
const brewingByRecipe = (state: State): Map<string, string[]> => {
  const brewing = new Map<string, string[]>();
  for (const batch of state.batches.values()) {
    const name = batch.recipe?.name;
    if (batch.lane.kind !== 'brewing' || name === undefined) continue;
    brewing.set(name, [...(brewing.get(name) ?? []), batch.id]);
  }
  return brewing;
};

/**
 * A tally of what is open and brewing now; `listed`: the Brewery's issues read in this pass. A
 * recipe counts its batches Brewing and the Ordered ones the pass will route to it, by their
 * Brewery issue's one label as listed, as the Brewery's `concurrency` counts both (ADR 0068).
 */
export const startTally = (
  state: State,
  listed: readonly TargetIssue[],
  limits: Limits,
): StartTally => {
  const labels = new Map(listed.map((found) => [found.number, found.labels]));
  const recipeOf = (issue: number | undefined): string | undefined =>
    issue === undefined ? undefined : oneRecipe(labels.get(issue) ?? []);
  const counts = new Map([...brewingByRecipe(state)].map(([name, ids]) => [name, ids.length]));
  for (const batch of state.batches.values()) {
    if (batch.lane.kind !== 'ordered') continue;
    const name = recipeOf(breweryIssueOf(state, batch));
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let open = openOrders(state).size;
  // The sub-orders with touches that brew, or that this walk started.
  const brewing = brewingTouching(state).map(({ subOrder }) => subOrder);
  const touchingOfEntry = ({ subOrder }: QueuedOrder): Touching | undefined =>
    subOrder === undefined ? undefined : touchingOf(state, subOrder.issue);
  // A target issue's recipe is its Brewery issue's, which exists only once it is claimed (ADR 0156).
  const entryRecipe = ({ order, subOrder }: QueuedOrder): string | undefined =>
    order.repo === undefined ? recipeOf(subOrder?.issue ?? order.issue) : undefined;
  return {
    hold: (entry) => {
      const name = entryRecipe(entry);
      const limit = name === undefined ? undefined : limits.recipe(name);
      if (name !== undefined && limit !== undefined && (counts.get(name) ?? 0) >= limit) {
        return { kind: 'recipe', recipe: name, limit };
      }
      // Only a new order: a sub-order is of an order already open, which it helps finish.
      if (entry.subOrder === undefined && open >= limits.openOrders) {
        return { kind: 'open_orders', limit: limits.openOrders };
      }
      const own = touchingOfEntry(entry);
      const holder = own === undefined ? undefined : brewing.find((other) => overlap(own, other));
      return holder === undefined ? undefined : { kind: 'touches', holder: holder.issue };
    },
    start: (entry) => {
      const name = entryRecipe(entry);
      if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
      if (entry.subOrder === undefined) open++;
      const own = touchingOfEntry(entry);
      if (own !== undefined) brewing.push(own);
    },
  };
};

/** What holds the route of an Ordered batch to `recipe`: its batches Brewing at its limit. */
export const routeHold = (state: State, recipe: string, limits: Limits): Hold | undefined => {
  const limit = limits.recipe(recipe);
  const brewing = brewingByRecipe(state).get(recipe)?.length ?? 0;
  return limit !== undefined && brewing >= limit ? { kind: 'recipe', recipe, limit } : undefined;
};

/** Why a hold holds, in one line. */
export const holdText = (hold: Hold): string => {
  switch (hold.kind) {
    case 'recipe':
      return `recipe ${hold.recipe} brews its ${hold.limit} at once (concurrency)`;
    case 'open_orders':
      return `${hold.limit} ${hold.limit === 1 ? 'order is' : 'orders are'} open, the Brewery's openOrders`;
    case 'touches':
      return `its touches overlap sub-order #${hold.holder}'s, which brews (touches)`;
    default: {
      const unhandled: never = hold;
      throw new Error(`Unhandled hold ${JSON.stringify(unhandled)}`);
    }
  }
};

/**
 * The lines `foedrum status` prints above the board: each limit that holds now, from the store
 * alone. A recipe counts only its batches Brewing, since its Ordered ones' labels are on GitHub.
 */
export const limitLines = (state: State, limits: Limits): string[] => {
  const lines: string[] = [];
  for (const [name, ids] of brewingByRecipe(state)) {
    const limit = limits.recipe(name);
    if (limit === undefined || ids.length < limit) continue;
    lines.push(
      `recipe ${name}: ${ids.length} of ${limit} at once (${ids.join(', ')}); its next orders wait`,
    );
  }
  const open = [...openOrders(state).values()];
  if (open.length >= limits.openOrders) {
    lines.push(
      `open orders: ${open.length} of ${limits.openOrders} (${open.join(', ')}); new orders wait`,
    );
  }
  const brewing = brewingTouching(state);
  for (const { issue } of readySubOrders(state)) {
    const own = touchingOf(state, issue);
    const holder = own === undefined ? undefined : brewing.find((it) => overlap(own, it.subOrder));
    if (holder === undefined) continue;
    lines.push(
      `sub-order #${issue} waits for sub-order #${holder.subOrder.issue} (${holder.batchId}): their touches overlap`,
    );
  }
  return lines;
};
