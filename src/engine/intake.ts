// The intake of target-repository issues (ADR 0043, #103). One pass, in this order:
// - records the end of each pull request of a claimed batch on tap that merged or closed
//   (`pull_request.ended`), the fact the release waits for;
// - claims the candidates of each repository with an intake filter, oldest first and only up to
//   the Brewery's free capacity, and orders what it won as `<alias>-<issue>`, Ordered until it is
//   routed by its deadline (ADR 0032).
// Everything it reads from the tracker is untrusted input; it decides nothing by asking a model.

import type { BreweryConfig } from '../schemas/brewery-config.ts';
import { targetBatchId } from './batch-id.ts';
import type { CommandLog } from './command-log.ts';
import type { EngineCommand } from './decide.ts';
import type { State } from './fold.ts';
import {
  type Claimant,
  type ClaimHost,
  claimCandidates,
  type IntakeFilter,
  type PullRequestState,
  type TargetIssue,
} from './issue-claims.ts';

/** What the intake reads of target repositories (architecture §3.1's `Tracker`, ADR 0008). */
export interface TargetTracker {
  /** The open issues of `repo`; pull requests may be among them. */
  issues(repo: string): Promise<readonly TargetIssue[]>;
  /** How the pull request at `url` stands now. */
  pullRequest(url: string): Promise<PullRequestState>;
}

/** A repository whose issues the intake polls: its alias starts the batch ids of its issues. */
export interface IntakeRepository {
  repo: string;
  alias: string;
  filter: IntakeFilter;
}

/** What the intake reports instead of failing: it goes on with the next repository. */
export type IntakeNotice =
  | { kind: 'ordered'; repo: string; issue: number; batchId: string }
  /** `by`: the Brewery the claim's record names, or undefined when it cannot be read. */
  | { kind: 'taken'; repo: string; issue: number; by: string | undefined }
  | { kind: 'refused'; command: EngineCommand; reason: string }
  /** A repository it could not list or claim in, or a pull request it could not read. */
  | { kind: 'failed'; what: string; error: unknown };

export interface IntakeOptions {
  log: CommandLog;
  tracker: TargetTracker;
  claims: ClaimHost;
  claimant: Claimant;
  /** The Brewery's allow-listed users (architecture §10). */
  authors: readonly string[];
  /** In the order the Brewery's config names them: the first take free places first. */
  repositories: readonly IntakeRepository[];
  /** How many batches may be Ordered or Brewing at once. */
  capacity: number;
  clock: () => Date;
  report?: (notice: IntakeNotice) => void;
}

export interface Intake {
  /** One pass; it reports what it could not do and never rejects for it. */
  poll(): Promise<void>;
}

/** How many batches the Brewery can start now: `capacity` less its Ordered and Brewing batches. */
export const freeCapacity = (state: State, capacity: number): number => {
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new RangeError(`The capacity must be a whole number of batches, got ${capacity}`);
  }
  let busy = 0;
  for (const { lane } of state.batches.values()) {
    if (lane.kind === 'ordered' || lane.kind === 'brewing') busy++;
  }
  return Math.max(0, capacity - busy);
};

/** The repositories of the config that name an intake filter, in the order it lists them. */
export const intakeRepositories = (config: BreweryConfig): IntakeRepository[] =>
  Object.entries(config.repositories).flatMap(([repo, { alias, intake }]) =>
    intake === undefined || alias === undefined ? [] : [{ repo, alias, filter: intake }],
  );

// GitHub compares repository names ignoring case.
const same = (one: string, other: string): boolean => one.toLowerCase() === other.toLowerCase();

export const createIntake = (options: IntakeOptions): Intake => {
  const { log, tracker, claims, claimant, authors, repositories, capacity, clock } = options;
  // A report that throws must not stop the intake.
  const report = (notice: IntakeNotice): void => {
    try {
      options.report?.(notice);
    } catch {}
  };
  const issue = (command: EngineCommand): boolean => {
    const decision = log.issue(command, clock());
    if (decision.kind === 'refused') report({ kind: 'refused', command, reason: decision.reason });
    return decision.kind === 'accepted';
  };

  /** Records the end of each pull request of a claimed batch on tap that merged or closed. */
  const recordEnds = async (): Promise<void> => {
    for (const batch of log.state().batches.values()) {
      if (batch.repo === undefined || batch.lane.kind !== 'on_tap') continue;
      for (const pullRequest of batch.lane.pullRequests) {
        if (batch.pullRequestEnds?.[pullRequest] !== undefined) continue;
        let state: PullRequestState;
        try {
          state = await tracker.pullRequest(pullRequest);
        } catch (error) {
          report({ kind: 'failed', what: `reading ${pullRequest}`, error });
          continue;
        }
        if (state === 'open') continue;
        const event = {
          type: 'pull_request.ended',
          batchId: batch.id,
          pullRequest,
          state,
        } as const;
        issue({ kind: 'record', event });
      }
    }
  };

  /** Claims and orders up to `free` candidates of `repository`; how many it ordered. */
  const claimIn = async (repository: IntakeRepository, free: number): Promise<number> => {
    const { repo, alias, filter } = repository;
    const brewed = new Set(
      [...log.state().batches.values()]
        .filter((batch) => batch.repo !== undefined && same(batch.repo, repo))
        .map((batch) => batch.issue),
    );
    const now = clock().toISOString();
    const pass = await claimCandidates(claims, await tracker.issues(repo), {
      repo,
      filter,
      claimant,
      brewed,
      authors,
      now,
      limit: free,
    });
    for (const { issue: number, by } of pass.taken)
      report({ kind: 'taken', repo, issue: number, by });
    let ordered = 0;
    for (const number of pass.order) {
      const batchId = targetBatchId(log.state(), alias, number);
      if (issue({ kind: 'order', batchId, order: { issue: number, repo } })) {
        ordered++;
        report({ kind: 'ordered', repo, issue: number, batchId });
      }
    }
    return ordered;
  };

  return {
    poll: async () => {
      await recordEnds();
      let free = freeCapacity(log.state(), capacity);
      for (const repository of repositories) {
        if (free === 0) break;
        try {
          free -= await claimIn(repository, free);
        } catch (error) {
          // A claim won before the failure is found as this Brewery's by the next pass.
          report({ kind: 'failed', what: `claiming in ${repository.repo}`, error });
        }
      }
    },
  };
};
