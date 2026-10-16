// Claiming a target-repository issue across Breweries before brewing it (ADR 0043): which issues
// the intake picks, the claim ref that exactly one Brewery creates, the marks people see, and the
// release when the batch ends. This module decides; the GitHub layer implements `ClaimHost` and
// turns each due effect into an `EffectTarget` (ADR 0033).

import type { BatchEffectKey } from '../schemas/store.ts';
import type { Lane } from './fold.ts';

/** The label a claimed issue carries while its batch brews. */
export const brewingLabel = 'foedrum: brewing';

/** The ref that claims `issue` in its repository: `refs/foedrum/claims/issues/<issue>`. */
export const claimRef = (_issue: number): string => {
  throw new Error('not implemented');
};

/** What the intake reads of a target-repository issue. */
export interface TargetIssue {
  number: number;
  state: 'open' | 'closed';
  /** GitHub lists pull requests among the issues. */
  pullRequest: boolean;
  labels: readonly string[];
  milestone: string | undefined;
  /** GitHub logins. */
  assignees: readonly string[];
}

/** Which issues of a repository a Brewery brews: all of `labels`, and `milestone` when set. */
export interface IntakeFilter {
  labels: readonly string[];
  milestone?: string;
}

/** The Brewery that claims: its repository (`owner/name`) and its token's GitHub login. */
export interface Claimant {
  brewery: string;
  login: string;
}

export interface CandidateOptions {
  filter: IntakeFilter;
  claimant: Claimant;
  /** The issues of this repository that have a batch in this Brewery, in any lane. */
  brewed: ReadonlySet<number>;
}

/** Whether the intake may claim `issue`: open, filtered in, unassigned or ours, never brewed. */
export const isCandidate = (_issue: TargetIssue, _options: CandidateOptions): boolean => {
  throw new Error('not implemented');
};

/** The code host side of a claim: the claim ref of an issue in a target repository. */
export interface ClaimHost {
  /**
   * Creates the claim ref of `issue`, pointing at a commit whose message is `message`;
   * `exists` when the ref is there already. Atomic: of two calls, at most one creates it.
   */
  create(repo: string, issue: number, message: string): Promise<'created' | 'exists'>;
  /** The message of the commit the claim ref points at, or undefined when there is no ref. */
  read(repo: string, issue: number): Promise<{ message: string } | undefined>;
  /** Deletes the claim ref; nothing happens when it is gone. */
  delete(repo: string, issue: number): Promise<void>;
}

/** How a claim went: created now, created by this Brewery before, or held by another. */
export type ClaimOutcome =
  | { kind: 'won' }
  | { kind: 'ours' }
  /** `by` is the Brewery the record names, or undefined when the record cannot be read. */
  | { kind: 'taken'; by: string | undefined };

/** Claims `issue` in `repo` for the claimant's Brewery. */
export const claimIssue = async (
  _host: ClaimHost,
  _claim: { repo: string; issue: number; brewery: string; now: string },
): Promise<ClaimOutcome> => {
  throw new Error('not implemented');
};

/** What one pass of the intake got for a repository's issues. */
export interface ClaimPass {
  /** The issues this Brewery holds the claim of and orders now, in issue order. */
  order: number[];
  /** The candidates another Brewery (or someone unknown) holds the claim of. */
  taken: { issue: number; by: string | undefined }[];
}

/** Claims every candidate of `issues`, one after the other, oldest issue first. */
export const claimCandidates = async (
  _host: ClaimHost,
  _issues: readonly TargetIssue[],
  _options: CandidateOptions & { repo: string; now: string },
): Promise<ClaimPass> => {
  throw new Error('not implemented');
};

/** Releases the claim when its record still names `brewery`; `gone` or `not_ours` otherwise. */
export const releaseClaim = async (
  _host: ClaimHost,
  _claim: { repo: string; issue: number; brewery: string },
): Promise<'released' | 'gone' | 'not_ours'> => {
  throw new Error('not implemented');
};

/** How a pull request of a batch stands. */
export type PullRequestState = 'open' | 'merged' | 'closed';

/** A batch of a claimed target-repository issue. */
export interface ClaimedBatch {
  batchId: string;
  repo: string;
  issue: number;
  lane: Lane;
}

/** What an effect of a claim does on the code host. */
export type ClaimEffect =
  | { kind: 'assign'; repo: string; issue: number; login: string }
  | { kind: 'add_label'; repo: string; issue: number; label: string }
  | { kind: 'remove_label'; repo: string; issue: number; label: string }
  | { kind: 'comment'; repo: string; issue: number; body: string }
  | { kind: 'release_ref'; repo: string; issue: number; brewery: string };

export interface DueClaimEffect {
  key: BatchEffectKey;
  effect: ClaimEffect;
}

/**
 * The effects of the batch's claim that are due, in the order to apply them: the marks while the
 * batch is live or its pull requests are open, the release once it is cancelled or every pull
 * request it opened is merged or closed. The ledger skips those already applied.
 */
export const claimEffectsDue = (
  _batch: ClaimedBatch,
  _claimant: Claimant,
  _pullRequest: (url: string) => PullRequestState,
): DueClaimEffect[] => {
  throw new Error('not implemented');
};
