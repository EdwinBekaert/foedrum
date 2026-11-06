// The decisions of node scripts/tasting-compare.ts --real (#879, ADR 0332): the brewed heads and the
// setups, the recipe and the Brewery's files of a run, a head's changed files, what a Taster's
// transcript says it read, a run's record, and the blinded lists. It scores nothing: a person does,
// against a key that stays out of the repository. Nothing here starts a process.

import type { Event } from '../../src/schemas/events.ts';
import type { Scripted } from '../../test/helpers/nip-fixture.ts';
import type { RunRecord } from './core.ts';

/** The three self-brew orders of #374, each as brewed, not as merged. */
export const REAL_ORDERS = [
  { order: 855, pullRequest: 859, base: '58db3d5e', head: '62d71154' },
  { order: 864, pullRequest: 866, base: 'b6db0ca8', head: '5590e9c5' },
  { order: 867, pullRequest: 868, base: '02eba0cd', head: 'f4fb4585' },
] as const;

/** The commit whose `taster.md` the `today` setup tastes with. */
export const TODAY_COMMIT = '765cc856';

type OrderNumber = (typeof REAL_ORDERS)[number]['order'];
type Profile = 'today' | 'reads';
/** One order tasted one way: the order first, so the record reads on its own. */
export type RealSetup = `${OrderNumber}-${Profile}`;
export type RealRecord = RunRecord<RealSetup>;

/** The one recipe every run brews. */
export const REAL_RECIPE = 'real-nip';

/** What a transcript says a Taster read. */
export interface TranscriptReads {
  /** The files the Taster read, by path in its worktree, once each. */
  opened: readonly string[];
  /** What it reached outside its worktree. */
  outside: readonly string[];
  /** What it asked for outside and was refused. */
  refused: readonly string[];
  /** Why the transcript cannot say what the Taster read. */
  problem?: string;
}

export const orderOf = (_setup: RealSetup): (typeof REAL_ORDERS)[number] => {
  throw new Error('not implemented');
};

export const realRecipeText = (): string => {
  throw new Error('not implemented');
};

export const realBreweryFiles = (
  _setup: RealSetup,
  _todayTaster: string,
): Record<string, string> => {
  throw new Error('not implemented');
};

export const changedFiles = (_nameStatus: string): string[] => {
  throw new Error('not implemented');
};

export const transcriptReads = (_text: string, _worktree: string): TranscriptReads => {
  throw new Error('not implemented');
};

export const realRecordOf = (
  _events: readonly { event: Event }[],
  _transcriptOf: (sessionId: string, worktree: string) => string | undefined,
): Pick<RealRecord, 'ended' | 'attempts'> => {
  throw new Error('not implemented');
};

export const nextRealRun = (
  _records: readonly RealRecord[],
  _runs: number,
): { setup: RealSetup; run: number; retry: boolean } | undefined => {
  throw new Error('not implemented');
};

export const codeOf = (_seed: string, _setup: RealSetup, _run: number): string => {
  throw new Error('not implemented');
};

export const blinded = (
  _records: readonly RealRecord[],
  _seed: string,
): { lists: Record<string, string>; codes: string } => {
  throw new Error('not implemented');
};

export const realTable = (_records: readonly RealRecord[]): string => {
  throw new Error('not implemented');
};

export const scriptedRealTastings = (_file: string): Record<string, readonly Scripted[]> => {
  throw new Error('not implemented');
};

export const scriptedTranscript = (_worktree: string): string => {
  throw new Error('not implemented');
};
