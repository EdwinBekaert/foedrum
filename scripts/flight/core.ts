// The decisions of node scripts/flight.ts (#1083, ADR 0409): its options and their refusals, the
// recipe a Flight brews with one brewer swapped, the model each step asks for, the dry run's
// scripted brewers, a run's record and when it stops the Flight, and the one table. Nothing here
// starts a process; scripts/flight.ts brews the runs through scripts/tasting-compare/harness.ts.

import type { parseArgs } from 'node:util';
import type { Event } from '../../src/schemas/events.ts';
import type { Effort } from '../../src/schemas/models.ts';
import type { Scripted } from '../../test/helpers/nip-fixture.ts';
import type { FlightOrder } from '../flight-orders.ts';
import type { RunRecord } from '../tasting-compare/core.ts';
import type { StepRun } from '../tasting-compare/real.ts';

/** The options flight.ts reads, as `parseArgs` takes them. */
export const FLIGHT_OPTIONS = {
  recipe: { type: 'string' },
  brewer: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  runs: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;

/** The values `parseArgs` reads of `FLIGHT_OPTIONS`. */
export type FlightValues = ReturnType<
  typeof parseArgs<{ options: typeof FLIGHT_OPTIONS }>
>['values'];

/** The brewer a Flight swaps: its steps, and only they, on this model and effort. */
export interface Swap {
  brewer: string;
  /** A level, which the brewer's steps name, or a model id, which models.jsonc maps a free level to. */
  model: string;
  effort: Effort;
}

/** What a Flight brews: a default recipe as it ships, or with one brewer swapped. */
export interface FlightSettings {
  recipe: string;
  swap?: Swap;
  runs: number;
  dryRun: boolean;
}

/**
 * The Flight `values` ask for, or the refusal that stops the script with exit 2; `recipeText`
 * gives a default recipe's text by its name, undefined when there is none.
 */
export const flightOptionsOf = (
  _values: FlightValues,
  _recipeText: (name: string) => string | undefined,
): ({ kind: 'flight' } & FlightSettings) | { kind: 'refused'; message: string } => {
  throw new Error('not implemented');
};

/** The Flight's folder under .foedrum/tmp/flight: the recipe, with a swap its brewer, model and effort. */
export const flightFolderOf = (_settings: FlightSettings): string => {
  throw new Error('not implemented');
};

/**
 * The scratch Brewery's files beyond Nip's: none for the recipe as it ships; with a swap, a copy of
 * the default recipe whose swapped brewer's steps name the model and effort, and a models.jsonc when
 * the model is an id; and always the target's test line.
 */
export const flightBreweryFiles = (
  _settings: FlightSettings,
  _recipeText: string,
  _names: { brewery: string; target: string; user: string },
): Record<string, string> => {
  throw new Error('not implemented');
};

/** The model each brewer step of the recipe asks for, by step id: a family, or a model id. */
export const askedModels = (
  _settings: FlightSettings,
  _recipeText: string,
): Map<string, string> => {
  throw new Error('not implemented');
};

/** What the dry run's scripted brewers play for `order`, by step id of the recipe. */
export const dryRunScript = (
  _order: FlightOrder,
  _recipeText: string,
): Record<string, readonly Scripted[]> => {
  throw new Error('not implemented');
};

/** How a run's hidden tests ended. */
export type Hidden = 'passed' | 'failed' | 'timed out';

/** What one run of a Flight measured (ADR 0409). */
export interface FlightRun {
  recipe: string;
  swap?: Swap;
  /** The commit a person gets from the batch, and where it was read. */
  head?: string;
  headFrom?: 'pull request' | 'green';
  hidden?: Hidden;
  /** The end of the hidden tests' output. */
  hiddenOutput?: string;
  changed: readonly string[];
  /** The changed files outside the order's allowed paths. */
  outside: readonly string[];
  steps: readonly StepRun[];
  /** The models each brewer step's transcripts name, by step id. */
  models: Readonly<Record<string, readonly string[]>>;
  /** Why a transcript cannot say its model. */
  unreadable?: string;
}

/** One run of an order: the order's name is its setup. */
export type FlightRecord = RunRecord<string> & { flight: FlightRun };

/** The head a person gets from the batch: its pull request's, or else the commit green last read. */
export const headOf = (
  _events: readonly { event: Event }[],
): Pick<FlightRun, 'head' | 'headFrom'> => {
  throw new Error('not implemented');
};

/** The changed files outside `allowedPaths`: a folder ends in `/`, any other entry is one file. */
export const outsidePaths = (
  _changed: readonly string[],
  _allowedPaths: readonly string[],
): string[] => {
  throw new Error('not implemented');
};

/** How the hidden tests ended by their exit code, null when they did not finish. */
export const hiddenOf = (_exitCode: number | null): Hidden => {
  throw new Error('not implemented');
};

/** A run's record from its store's events, before its hidden tests ran. */
export const flightRecordOf = (
  _events: readonly { event: Event }[],
  _settings: FlightSettings,
  _asked: ReadonlyMap<string, string>,
  _transcriptOf: (sessionId: string, worktree: string) => string | undefined,
): Pick<FlightRecord, 'ended' | 'attempts' | 'flight'> => {
  throw new Error('not implemented');
};

/** Why a run measured nothing, or undefined: its batch left no head. */
export const flightFailure = (
  _record: Pick<FlightRecord, 'ended' | 'flight'>,
): string | undefined => {
  throw new Error('not implemented');
};

/** Why a run stops the Flight, or undefined: a transcript that cannot say, or a model not asked for. */
export const flightStop = (
  _record: Pick<FlightRecord, 'setup' | 'flight'>,
  _asked: ReadonlyMap<string, string>,
): string | undefined => {
  throw new Error('not implemented');
};

/** The next run to brew of `orders` (`nextRunOf`). */
export const nextFlightRun = (
  _records: readonly FlightRecord[],
  _runs: number,
  _orders: readonly string[],
): { setup: string; run: number; retry: boolean } | undefined => {
  throw new Error('not implemented');
};

/** One row per order: its runs, hidden tests passed, runs with outside changes, tokens and time. */
export const flightTable = (_records: readonly FlightRecord[]): string => {
  throw new Error('not implemented');
};
