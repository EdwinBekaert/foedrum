// The decisions of node scripts/tasting-compare.ts (#567, ADR 0224): the three setups and their
// recipes, the seeded change's key, how a run's Taster attempts are scored against it, the sums
// over runs, which run is next, the rule that picks a recipe's choice, and the one table.
// scripts/tasting-compare.ts brews the runs with the real claude; nothing here starts a process.

import type { Usage } from '../../src/schemas/events.ts';
import type { TastingFinding } from '../../src/schemas/out-doc.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';

/** The seven default diff lenses, in the order the apart setup's group runs them. */
const SEVEN = [
  'diff/acceptance',
  'diff/correctness',
  'diff/cross-platform',
  'diff/design-conformance',
  'diff/necessity',
  'diff/security',
  'diff/test-design',
] as const;

/** A setup that runs, and its lenses. */
export const SETUPS = {
  'apart-7': { lenses: SEVEN as readonly string[] },
  'together-7': { lenses: SEVEN as readonly string[] },
  'together-nip': { lenses: ['diff/correctness', 'diff/acceptance'] as readonly string[] },
} as const;
export type SetupName = keyof typeof SETUPS;

/** One planted defect: its lens, its file, the line ranges it is in, and what it is. */
export interface Defect {
  id: string;
  lens: string;
  file: string;
  lines: readonly (readonly [number, number])[];
  what: string;
}
export interface Key {
  defects: readonly Defect[];
}

/** A Taster's step's attempt as `step.finished` records it. */
export interface FinishedAttempt {
  stepId: string;
  attempt: number;
  outcome: StepOutcome;
  usage?: Usage | undefined;
  receipt?: { turns: number; durationMs?: number | undefined } | undefined;
}

/** One Taster attempt of a run. */
export interface TasterAttempt {
  stepId: string;
  lenses: readonly string[];
  /** Why the attempt did not succeed with a valid out doc; undefined when it did. */
  failure: string | undefined;
  findings: readonly TastingFinding[];
  usage: Usage | undefined;
  turns: number | undefined;
  durationMs: number | undefined;
}

/** One run of a setup, as the shell keeps it. */
export interface RunRecord {
  setup: SetupName;
  run: number;
  /** A failed run's second go. */
  retry?: true;
  /** `on_tap`, or how the batch ended instead. */
  ended: string;
  wallMs: number;
  attempts: readonly TasterAttempt[];
}

export const readKey = (_text: string): Key => {
  throw new Error('not implemented');
};
export const addedLines = (_patch: string): Map<string, Set<number>> => {
  throw new Error('not implemented');
};
export const keyProblems = (_key: Key, _patch: string): string[] => {
  throw new Error('not implemented');
};
export const recipeText = (_setup: SetupName): string => {
  throw new Error('not implemented');
};
export const attemptsOf = (
  _finished: readonly FinishedAttempt[],
  _setup: SetupName,
): TasterAttempt[] => {
  throw new Error('not implemented');
};
export const runFailure = (_record: RunRecord): string | undefined => {
  throw new Error('not implemented');
};

/** A finding outside the key, for a person to judge. */
export interface OtherFinding {
  stepId: string;
  finding: TastingFinding;
}
export interface RunScore {
  found: { defect: string; ownLens: boolean }[];
  others: OtherFinding[];
}
export const scoreRun = (_record: RunRecord, _key: Key): RunScore => {
  throw new Error('not implemented');
};

/** A setup as the table shows it: the three that run, and Nip's two apart read from apart-7. */
export type Shown = SetupName | 'apart-nip';
export interface Tokens extends Usage {
  total: number;
}
export interface SetupSummary {
  setup: Shown;
  /** The planted defects of the setup's lenses. */
  defects: number;
  found: number[];
  ownLens: number[];
  meanFound: number;
  perDefect: Map<string, number>;
  others: OtherFinding[][];
  meanTokens: Tokens;
  meanTurns: number;
  meanAttemptMs: number;
  meanWallMs: number;
  failed: { run: number; why: string }[];
}
export const summarize = (_records: readonly RunRecord[], _key: Key): SetupSummary[] => {
  throw new Error('not implemented');
};
export const nextRun = (
  _records: readonly RunRecord[],
  _runs: number,
): { setup: SetupName; run: number; retry: boolean } | undefined => {
  throw new Error('not implemented');
};
export type Choice = 'together' | 'apart';
export const choiceOf = (
  _summaries: readonly Pick<SetupSummary, 'setup' | 'meanFound' | 'meanTokens'>[],
): { seven: Choice | undefined; nip: Choice | undefined } => {
  throw new Error('not implemented');
};
export const escapeCell = (_text: string): string => {
  throw new Error('not implemented');
};
export const tableMarkdown = (_summaries: readonly SetupSummary[], _key: Key): string => {
  throw new Error('not implemented');
};
