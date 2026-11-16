// The command line of scripts/tasting-compare.ts (#1094): its options, and which mode they run with
// its settings, or the refusal that stops it before anything brews.

import type { parseArgs } from 'node:util';
import type { SeededTaster } from './core.ts';
import type {
  BrewerSettings,
  BrewerSetup,
  PlannerSetup,
  RealSetup,
  TasterSettings,
  TasterSetup,
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

/** The mode `values` run, or the refusal that stops the script with exit 2. */
export const tastingModeOf = (
  _values: TastingValues,
): TastingMode | { kind: 'refused'; message: string } => {
  throw new Error('not implemented');
};
