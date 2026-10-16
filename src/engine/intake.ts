// The intake of target-repository issues (ADR 0043, #103).

import type { BreweryConfig } from '../schemas/brewery-config.ts';
import type { CommandLog } from './command-log.ts';
import type { EngineCommand } from './decide.ts';
import type { State } from './fold.ts';
import type {
  Claimant,
  ClaimHost,
  IntakeFilter,
  PullRequestState,
  TargetIssue,
} from './issue-claims.ts';

export interface TargetTracker {
  issues(repo: string): Promise<readonly TargetIssue[]>;
  pullRequest(url: string): Promise<PullRequestState>;
}

export interface IntakeRepository {
  repo: string;
  alias: string;
  filter: IntakeFilter;
}

export type IntakeNotice =
  | { kind: 'ordered'; repo: string; issue: number; batchId: string }
  | { kind: 'taken'; repo: string; issue: number; by: string | undefined }
  | { kind: 'refused'; command: EngineCommand; reason: string }
  | { kind: 'failed'; what: string; error: unknown };

export interface IntakeOptions {
  log: CommandLog;
  tracker: TargetTracker;
  claims: ClaimHost;
  claimant: Claimant;
  authors: readonly string[];
  repositories: readonly IntakeRepository[];
  capacity: number;
  clock: () => Date;
  report?: (notice: IntakeNotice) => void;
}

export interface Intake {
  poll(): Promise<void>;
}

export const freeCapacity = (_state: State, _capacity: number): number => {
  throw new Error('not implemented');
};

export const intakeRepositories = (_config: BreweryConfig): IntakeRepository[] => {
  throw new Error('not implemented');
};

export const createIntake = (_options: IntakeOptions): Intake => {
  throw new Error('not implemented');
};
