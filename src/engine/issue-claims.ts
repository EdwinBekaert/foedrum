// Claiming a target-repository issue across Breweries before brewing it (ADR 0043): which issues
// the intake picks, the claim ref that exactly one Brewery creates, the marks people see, and the
// release when the batch ends. This module decides; the GitHub layer implements `ClaimHost` and
// turns each due effect into an `EffectTarget` (ADR 0033).

import type { IntakeFilter } from '../schemas/brewery-config.ts';
import { ClaimRecord } from '../schemas/claim.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import type { Lane } from './fold.ts';

/** Which issues of a repository a Brewery brews: all of `labels`, and `milestone` when set. */
export type { IntakeFilter };

/** The label a claimed issue carries until its claim is released. */
export const claimLabel = 'foedrum:claimed';

/** The ref that claims `issue` in its repository: `refs/foedrum/claims/issues/<issue>`. */
export const claimRef = (issue: number): string => {
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new RangeError(`The issue must be a positive integer, got ${issue}`);
  }
  return `refs/foedrum/claims/issues/${issue}`;
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
  /** The GitHub login that opened the issue. */
  author: string;
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
  /** The Brewery's allow-listed users: only an issue one of them opened can become an order. */
  authors: readonly string[];
}

// GitHub compares logins, label names and repository names ignoring case.
export const same = (one: string, other: string): boolean =>
  one.toLowerCase() === other.toLowerCase();

/** Whether `issue` has all of the filter's labels, and its milestone when it names one. */
export const passesFilter = (issue: TargetIssue, filter: IntakeFilter): boolean =>
  filter.labels.every((wanted) => issue.labels.some((label) => same(label, wanted))) &&
  (filter.milestone === undefined || issue.milestone === filter.milestone);

/** Whether the intake may claim `issue`: open, filtered in, unassigned or ours, never brewed. */
export const isCandidate = (issue: TargetIssue, options: CandidateOptions): boolean => {
  const { filter, claimant, brewed } = options;
  return (
    issue.state === 'open' &&
    !issue.pullRequest &&
    passesFilter(issue, filter) &&
    // An issue assigned to a person is that person's; this Brewery's own user is its person.
    issue.assignees.every((assignee) => same(assignee, claimant.login)) &&
    // A target repository may be open to anyone; only allow-listed users order work.
    options.authors.some((author) => same(author, issue.author)) &&
    !brewed.has(issue.number)
  );
};

/** The code host side of a claim: the claim ref of an issue in a target repository. */
export interface ClaimHost {
  /**
   * Creates the claim ref of `issue`, pointing at a commit whose message is `message`;
   * `exists` when the ref is there already. Atomic: of two calls, at most one creates it.
   */
  create(
    repo: string,
    issue: number,
    message: string,
    signal?: AbortSignal,
  ): Promise<'created' | 'exists'>;
  /**
   * The commit the claim ref points at and that commit's message, or undefined when there is no
   * ref.
   */
  read(
    repo: string,
    issue: number,
    signal?: AbortSignal,
  ): Promise<{ sha: string; message: string } | undefined>;
  /**
   * Deletes the claim ref only while it still points at `sha`, in one step on the code host;
   * false when it points elsewhere or is gone.
   */
  delete(repo: string, issue: number, sha: string, signal?: AbortSignal): Promise<boolean>;
}

/** How a claim went: created now, created by this Brewery before, or held by another. */
export type ClaimOutcome =
  | { kind: 'won' }
  | { kind: 'ours' }
  /** `by` is the Brewery the record names, or undefined when the record cannot be read. */
  | { kind: 'taken'; by: string | undefined };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// The Brewery a claim ref's message names for `issue`, or undefined when it names none. The ref
// was made by someone with push access, but its message is still read as untrusted text.
const claimedBy = async (
  host: ClaimHost,
  repo: string,
  issue: number,
  signal?: AbortSignal,
): Promise<{ found: false } | { found: true; sha: string; brewery: string | undefined }> => {
  const ref = await host.read(repo, issue, signal);
  if (ref === undefined) return { found: false };
  const record = ClaimRecord.safeParse(parseJson(ref.message));
  const brewery = record.success && record.data.issue === issue ? record.data.brewery : undefined;
  return { found: true, sha: ref.sha, brewery };
};

/** Claims `issue` in `repo` for the claimant's Brewery. */
export const claimIssue = async (
  host: ClaimHost,
  claim: {
    repo: string;
    issue: number;
    brewery: string;
    now: string;
    signal?: AbortSignal | undefined;
  },
): Promise<ClaimOutcome> => {
  const { repo, issue, brewery, now, signal } = claim;
  const message = JSON.stringify(ClaimRecord.parse({ brewery, issue, claimedAt: now }));
  if ((await host.create(repo, issue, message, signal)) === 'created') return { kind: 'won' };
  const holder = await claimedBy(host, repo, issue, signal);
  // Gone between creating and reading it: released in between; the next poll tries again.
  if (!holder.found || holder.brewery === undefined) return { kind: 'taken', by: undefined };
  return same(holder.brewery, brewery) ? { kind: 'ours' } : { kind: 'taken', by: holder.brewery };
};

/** What one pass of the intake got for a repository's issues. */
export interface ClaimPass {
  /** The issues this Brewery holds the claim of and orders now, in issue order. */
  order: number[];
  /** The candidates another Brewery (or someone unknown) holds the claim of. */
  taken: { issue: number; by: string | undefined }[];
  /**
   * The candidate whose claim the code host failed: the pass stopped there, and the claims before
   * it are in `order`, so they are ordered now and never left without a batch.
   */
  failed?: { issue: number; error: unknown };
}

/**
 * Claims the candidates of `issues`, one after the other, oldest issue first, until it orders
 * `limit` of them; the rest wait for the next pass, or for another Brewery. It stops at the first
 * claim the code host fails, and returns what it holds so far with the failure.
 */
export const claimCandidates = async (
  host: ClaimHost,
  issues: readonly TargetIssue[],
  /** `limit`: the Brewery's free capacity, how many batches it can start now. */
  /** `signal`: handed to the code host; once it aborts, the next claim fails and the pass stops. */
  options: CandidateOptions & {
    repo: string;
    now: string;
    limit: number;
    signal?: AbortSignal | undefined;
  },
): Promise<ClaimPass> => {
  const { repo, now, claimant, limit, signal } = options;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`The limit must be a whole number of batches, got ${limit}`);
  }
  const candidates = issues
    .filter((issue) => isCandidate(issue, options))
    .map((issue) => issue.number)
    // Once each: a listing whose pages shift while it is read can return an issue twice.
    .filter((number, index, numbers) => numbers.indexOf(number) === index)
    .sort((one, other) => one - other);
  const pass: ClaimPass = { order: [], taken: [] };
  for (const issue of candidates) {
    // A taken claim costs no capacity, so the pass goes on to the next candidate.
    if (pass.order.length === limit) break;
    let outcome: ClaimOutcome;
    try {
      signal?.throwIfAborted();
      outcome = await claimIssue(host, { repo, issue, brewery: claimant.brewery, now, signal });
    } catch (error) {
      pass.failed = { issue, error };
      break;
    }
    switch (outcome.kind) {
      case 'won':
      case 'ours':
        pass.order.push(issue);
        break;
      case 'taken':
        pass.taken.push({ issue, by: outcome.by });
        break;
      default:
        outcome satisfies never;
    }
  }
  return pass;
};

/** Releases the claim when its record still names `brewery`; `gone` or `not_ours` otherwise. */
export const releaseClaim = async (
  host: ClaimHost,
  claim: { repo: string; issue: number; brewery: string; signal?: AbortSignal | undefined },
): Promise<'released' | 'gone' | 'not_ours'> => {
  const { repo, issue, brewery, signal } = claim;
  const holder = await claimedBy(host, repo, issue, signal);
  if (!holder.found) return 'gone';
  if (holder.brewery === undefined || !same(holder.brewery, brewery)) return 'not_ours';
  // Only the commit that was read: a claim made since then is someone else's.
  return (await host.delete(repo, issue, holder.sha, signal)) ? 'released' : 'not_ours';
};

/** How a pull request of a batch stands. */
export type PullRequestState = 'open' | 'merged' | 'closed';

/**
 * The Brewery issue that is the order of a claimed batch (ADR 0144): the one an earlier batch of the
 * same issue opened, and whether a release closed it since, and the batch's own once it is known.
 */
export interface ClaimOrder {
  earlier?: { issue: number; closed: boolean };
  issue?: number;
}

/** A batch of a claimed target-repository issue. */
export interface ClaimedBatch {
  batchId: string;
  repo: string;
  issue: number;
  lane: Lane;
  /** Its Brewery issue; absent as for a batch whose Brewery issue nothing opened yet. */
  order?: ClaimOrder;
}

/** What an effect of a claim does on the code host. */
export type ClaimEffect =
  | { kind: 'assign'; repo: string; issue: number; login: string }
  | { kind: 'add_label'; repo: string; issue: number; label: string }
  | { kind: 'remove_label'; repo: string; issue: number; label: string }
  | { kind: 'comment'; repo: string; issue: number; body: string }
  | { kind: 'release_ref'; repo: string; issue: number; brewery: string }
  /** Opens the Brewery issue of the claimed `repo#issue` in `brewery`, with its title (ADR 0144). */
  | { kind: 'open_order'; repo: string; issue: number; brewery: string; body: string }
  /** Closes or reopens the issue `repo#issue`: the Brewery issue of a claimed batch. */
  | { kind: 'issue_state'; repo: string; issue: number; state: 'open' | 'closed' };

export interface DueClaimEffect {
  key: BatchEffectKey;
  effect: ClaimEffect;
}

type Release = 'cancelled' | 'merged' | 'closed' | 'no_pull_request';

// Why the claim ends now, or undefined while the batch is live or a pull request of it is open.
const releaseOf = (
  lane: Lane,
  pullRequest: (url: string) => PullRequestState,
): Release | undefined => {
  switch (lane.kind) {
    case 'ordered':
    case 'brewing':
    case 'conditioning':
    case 'stuck':
      return undefined;
    case 'cancelled':
      return 'cancelled';
    case 'on_tap': {
      const states = lane.pullRequests.map(pullRequest);
      // `every` holds for no pull requests at all, which merged nothing.
      if (states.length === 0) return 'no_pull_request';
      if (states.includes('open')) return undefined;
      return states.every((state) => state === 'merged') ? 'merged' : 'closed';
    }
    default:
      return lane satisfies never;
  }
};

/**
 * Where the claim of a batch stands: `held` while the batch is live or a pull request of it has no
 * recorded end, `releasing` once its release is due and until `applied` has every effect of it,
 * then `released` (ADR 0105).
 */
export const claimStanding = (
  batch: ClaimedBatch,
  pullRequest: (url: string) => PullRequestState,
  applied: (key: BatchEffectKey) => boolean,
): 'held' | 'releasing' | 'released' => {
  if (releaseOf(batch.lane, pullRequest) === undefined) return 'held';
  // Only the keys count, and no key names the claimant: its Brewery and login are in the text.
  const release = claimEffectsDue(batch, { brewery: batch.repo, login: '' }, pullRequest);
  return release.every(({ key }) => applied(key)) ? 'released' : 'releasing';
};

// The assignee keeps every Brewery off an issue that is not done, until a person decides.
const available = ' Unassign the issue to make it available again.';

const released: Record<Release, string> = {
  cancelled: `was cancelled.${available}`,
  merged: 'is done: its pull requests were merged.',
  closed: `ended: a pull request was closed without being merged.${available}`,
  no_pull_request: `ended without a pull request.${available}`,
};

/**
 * The effects of the batch's claim that are due, in the order to apply them: the marks while the
 * batch is live or its pull requests are open, the release once it is cancelled or every pull
 * request it opened is merged or closed. The ledger skips those already applied.
 */
export const claimEffectsDue = (
  batch: ClaimedBatch,
  claimant: Claimant,
  pullRequest: (url: string) => PullRequestState,
): DueClaimEffect[] => {
  const { batchId, repo, issue } = batch;
  const { brewery, login } = claimant;
  const due = (effect: string, does: ClaimEffect): DueClaimEffect => ({
    key: { batchId, effect },
    effect: does,
  });
  const release = releaseOf(batch.lane, pullRequest);
  if (release === undefined) {
    return [
      due('claim.assignee', { kind: 'assign', repo, issue, login }),
      due('claim.label', { kind: 'add_label', repo, issue, label: claimLabel }),
      due('claim.comment', {
        kind: 'comment',
        repo,
        issue,
        body: `The Brewery \`${brewery}\` is brewing this issue as batch \`${batchId}\`, and holds its claim until the batch ends. To release it by hand, delete the ref \`${claimRef(issue)}\` and unassign the issue.`,
      }),
    ];
  }
  // The assignee stays: removing it would hand the issue to the next Brewery that polls.
  // The ref goes last, so the issue is never claimable while the marks are still on it.
  return [
    due('release.label', { kind: 'remove_label', repo, issue, label: claimLabel }),
    due('release.comment', {
      kind: 'comment',
      repo,
      issue,
      body: `The Brewery \`${brewery}\` released its claim on this issue: batch \`${batchId}\` ${released[release]}`,
    }),
    due('release.ref', { kind: 'release_ref', repo, issue, brewery }),
  ];
};
