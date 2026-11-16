// The command line of scripts/tasting-compare.ts (#1094): its options, and which mode they run with
// its settings, or the refusal that stops it before anything brews.

import type { parseArgs } from 'node:util';
import { type SeededTaster, seededTasterOf } from './core.ts';
import {
  type BrewerSettings,
  type BrewerSetup,
  brewerSettingsOf,
  brewerSetups,
  type PlannerSetup,
  plannerSetups,
  REAL_SETUPS,
  type RealSetup,
  realFolders,
  selectRealSetups,
  subOrdersRunOf,
  type TasterSettings,
  type TasterSetup,
  tasterSetups,
} from './real.ts';

/** The options tasting-compare.ts reads, as `parseArgs` takes them. */
export const TASTING_OPTIONS = {
  runs: { type: 'string' },
  'dry-run': { type: 'boolean' },
  plan: { type: 'boolean' },
  real: { type: 'boolean' },
  setups: { type: 'string' },
  orders: { type: 'string' },
  comparison: { type: 'string' },
  brewer: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  'sub-orders': { type: 'boolean' },
  'order-text': { type: 'string' },
  map: { type: 'boolean' },
  lenses: { type: 'string' },
  rules: { type: 'string' },
} as const;

/** The values `parseArgs` reads of `TASTING_OPTIONS`. */
export type TastingValues = ReturnType<
  typeof parseArgs<{ options: typeof TASTING_OPTIONS }>
>['values'];

/**
 * The mode a command line runs, with its settings: the planning runs (ADR 0396), a Taster setup
 * built from settings (ADR 0402), a real brewer's (ADR 0394), the real mode's fixed setups
 * (ADR 0332), the seeded plan (ADR 0323), or the seeded change (ADR 0224, ADR 0405).
 */
export type TastingMode = { runs: number; dryRun: boolean } & (
  | { kind: 'planner'; setups: readonly PlannerSetup[]; folders: string[] }
  | {
      kind: 'taster';
      settings: TasterSettings;
      setups: readonly TasterSetup[];
      folders: string[];
    }
  | {
      kind: 'brewer';
      settings: BrewerSettings;
      setups: readonly BrewerSetup[];
      folders: string[];
    }
  | { kind: 'real'; setups: readonly RealSetup[]; folders: string[] }
  | { kind: 'plan' }
  | { kind: 'seeded'; taster?: SeededTaster }
);

/**
 * The mode `values` run, or the refusal that stops the script with exit 2, checked in the order
 * the script has always checked them, so the first that applies is the one given.
 */
export const tastingModeOf = (
  values: TastingValues,
): TastingMode | { kind: 'refused'; message: string } => {
  try {
    return modeOf(values);
  } catch (error) {
    // Every check of the options throws its refusal's message.
    return { kind: 'refused', message: (error as Error).message };
  }
};

const modeOf = (values: TastingValues): TastingMode => {
  if (values.plan === true && values.real === true) {
    throw new Error('--plan and --real are two comparisons: give one of them');
  }
  if (values.setups !== undefined && values.real !== true) {
    throw new Error('--setups chooses among the setups of --real: give --real too');
  }
  const settings = brewerSettingsOf({ ...values, orderText: values['order-text'] });
  const taster = seededTasterOf(values);
  const subOrders = subOrdersRunOf({ ...values, subOrders: values['sub-orders'] });
  const { orders, setups } = values;
  if (orders !== undefined && setups === undefined && settings === undefined && !subOrders) {
    throw new Error(
      '--orders chooses the orders of the setups --setups, the runs --brewer or the plans --sub-orders names: give one of them too',
    );
  }
  const realSetups = setups === undefined ? REAL_SETUPS : selectRealSetups(setups, orders);
  if (values.comparison !== undefined && values.real !== true) {
    throw new Error('--comparison names a comparison of --real: give --real too');
  }
  const folders = realFolders(values.comparison);
  const runs = Number(values.runs ?? '3');
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error(`--runs must be a whole number of at least 1, not ${values.runs}`);
  }
  const common = { runs, dryRun: values['dry-run'] === true };
  if (subOrders) {
    return { kind: 'planner', setups: plannerSetups(orders), folders, ...common };
  }
  if (settings?.brewer === 'taster') {
    const tasters = tasterSetups(settings, orders);
    return { kind: 'taster', settings, setups: tasters, folders, ...common };
  }
  if (settings !== undefined) {
    const brewers = brewerSetups(settings, orders);
    return { kind: 'brewer', settings, setups: brewers, folders, ...common };
  }
  if (values.real === true) return { kind: 'real', setups: realSetups, folders, ...common };
  if (values.plan === true) return { kind: 'plan', ...common };
  return { kind: 'seeded', ...(taster === undefined ? {} : { taster }), ...common };
};
