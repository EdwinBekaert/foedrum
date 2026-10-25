// The intake (ADR 0008, ADR 0043, ADR 0068). One pass, in this order:
// - records the end of each pull request of a claimed batch on tap that merged or closed
//   (`pull_request.ended`), the fact the release waits for;
// - orders the Brewery's own issues that carry a `recipe:<name>` label as `<issue>-1`, then claims
//   the candidates of each repository with an intake filter and orders what it won as
//   `<alias>-<issue>`, oldest first and only up to the Brewery's free capacity, each Ordered until
//   it is routed by its deadline (ADR 0032);
// - routes every Ordered batch whose Brewery issue it read by that issue's one `recipe:<name>`
//   label, whoever ordered it: this pass, a pass killed before it routed, or a retry. A claimed
//   batch's Brewery issue is its order (ADR 0144, ADR 0156), never the target issue.
// Everything it reads from the tracker is untrusted input; it decides nothing by asking a model.

import type { BreweryConfig } from '../schemas/brewery-config.ts';
import type { BaseCheckRepository } from './base-check.ts';
import { nextBatchId, targetBatchId } from './batch-id.ts';
import { defaultLeaseMs } from './batch-leases.ts';
import { breweryIssueOf, claimOfOrder } from './claim-orders.ts';
import type { CommandLog } from './command-log.ts';
import type { EngineCommand } from './decide.ts';
import { emptyState, type State } from './fold.ts';
import {
  type Claimant,
  type ClaimHost,
  claimCandidates,
  type IntakeFilter,
  type PullRequestState,
  same,
  type TargetIssue,
} from './issue-claims.ts';

/**
 * What the intake reads: the open issues of a target repository (architecture §3.1's `Tracker`,
 * ADR 0008) and how a pull request of a batch stands (its `CodeHost`). On GitHub both are one API
 * (ADR 0050).
 */
export interface TargetTracker {
  /**
   * The open issues of `repo`; pull requests may be among them. With `filter`, the code host may
   * leave out issues that do not pass it, but need not: the caller checks every issue again
   * (ADR 0068). Stops when `signal` aborts.
   */
  issues(
    repo: string,
    filter?: IntakeFilter,
    signal?: AbortSignal,
  ): Promise<readonly TargetIssue[]>;
  /** How the pull request at `url` stands now. */
  pullRequest(url: string, signal?: AbortSignal): Promise<PullRequestState>;
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
  /** An Ordered batch routed by its issue's `recipe:<name>` label (ADR 0068). */
  | { kind: 'routed'; batchId: string; recipe: string }
  /** An Ordered batch whose label names no one recipe it can brew; reported once per reason. */
  | { kind: 'unrouted'; batchId: string; reason: string }
  /** A repository it could not list or claim in, or a pull request it could not read. */
  | { kind: 'failed'; what: string; error: unknown };

export interface IntakeOptions {
  log: CommandLog;
  /**
   * The Brewery's owner/name: when given, a pass orders its labelled issues and routes the
   * Ordered batches by their labels (ADR 0068), a claimed batch by its Brewery issue's (ADR 0156).
   */
  brewery?: string;
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
  /**
   * How long one pass may take: whole milliseconds, at most half the default batch lease (2.5
   * min), and that by default. A pass makes many requests, each with its own timeout, so it needs a
   * bound of its own. `serve` runs it beside the driver's ticks, never inside one, and the deadline
   * bounds how long a stop waits for it (ADR 0044, ADR 0068, #130).
   */
  deadlineMs?: number;
  /**
   * The repositories whose open pull requests each pass checks against their base once its tip
   * moves (ADR 0198); none by default, and none on a git without `merge-tree --write-tree`.
   */
  bases?: readonly BaseCheckRepository[];
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

/** The recipe names of an issue's `recipe:<name>` labels, the prefix in any case. */
export const recipeLabels = (labels: readonly string[]): string[] =>
  labels.flatMap((label) => {
    const name = /^recipe:(.+)$/i.exec(label)?.[1];
    return name === undefined ? [] : [name];
  });

/**
 * Whether the intake orders the Brewery's issue `issue` (ADR 0068): open, not a pull request, opened
 * by one of `authors`, with a `recipe:<name>` label, and with no batch here in any lane. A
 * sub-order is ordered by its decomposition, and the order of a claimed issue by its claim, never by
 * the intake (ADR 0144).
 */
export const isBreweryOrder = (
  issue: TargetIssue,
  state: State,
  authors: readonly string[],
): boolean =>
  issue.state === 'open' &&
  !issue.pullRequest &&
  recipeLabels(issue.labels).length > 0 &&
  authors.some((author) => same(author, issue.author)) &&
  (state.orders.get(issue.number)?.batchIds.length ?? 0) === 0 &&
  !state.subOrders.has(issue.number) &&
  claimOfOrder(state, issue.number) === undefined;

/** The repositories of the config that name an intake filter, in the order it lists them. */
export const intakeRepositories = (config: BreweryConfig): IntakeRepository[] =>
  Object.entries(config.repositories).flatMap(([repo, { alias, intake }]) =>
    intake === undefined || alias === undefined ? [] : [{ repo, alias, filter: intake }],
  );

export const createIntake = (options: IntakeOptions): Intake => {
  const { log, brewery, tracker, claims, claimant, authors, repositories, capacity, clock } =
    options;
  const most = defaultLeaseMs / 2;
  const { deadlineMs = most } = options;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > most) {
    throw new RangeError(
      `The deadline of an intake pass must be a whole number of milliseconds up to ${most}, got ${deadlineMs}`,
    );
  }
  // Checked once here, so that no poll rejects for it.
  freeCapacity(emptyState, capacity);
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
  const recordEnds = async (signal: AbortSignal): Promise<void> => {
    for (const batch of log.state().batches.values()) {
      if (batch.repo === undefined || batch.lane.kind !== 'on_tap') continue;
      for (const pullRequest of batch.lane.pullRequests) {
        if (batch.pullRequestEnds?.[pullRequest] !== undefined) continue;
        let state: PullRequestState;
        try {
          state = await tracker.pullRequest(pullRequest, signal);
        } catch (error) {
          report({ kind: 'failed', what: `reading ${pullRequest}`, error });
          continue;
        }
        // A pass given up at its deadline records nothing more.
        if (state === 'open' || signal.aborted) continue;
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

  /** Claims and orders up to `free` of the candidates `listed` in `repository`; how many it ordered. */
  const claimIn = async (
    repository: IntakeRepository,
    listed: readonly TargetIssue[],
    free: number,
    signal: AbortSignal,
  ): Promise<number> => {
    const { repo, alias, filter } = repository;
    const brewed = new Set(
      [...log.state().batches.values()]
        .filter((batch) => batch.repo !== undefined && same(batch.repo, repo))
        .map((batch) => batch.issue),
    );
    const now = clock().toISOString();
    const pass = await claimCandidates(claims, listed, {
      repo,
      filter,
      claimant,
      brewed,
      authors,
      now,
      limit: free,
      signal,
    });
    for (const { issue: number, by } of pass.taken)
      report({ kind: 'taken', repo, issue: number, by });
    if (pass.failed !== undefined) {
      const { issue: number, error } = pass.failed;
      report({ kind: 'failed', what: `claiming ${repo}#${number}`, error });
    }
    let ordered = 0;
    for (const number of pass.order) {
      // A pass given up at its deadline orders nothing: the next pass finds its claims as ours.
      if (signal.aborted) break;
      const batchId = targetBatchId(log.state(), alias, number);
      if (issue({ kind: 'order', batchId, order: { issue: number, repo } })) {
        ordered++;
        report({ kind: 'ordered', repo, issue: number, batchId });
      }
    }
    return ordered;
  };

  /** Orders up to `free` of the Brewery's issues `listed`, oldest first; how many it ordered. */
  const orderBrewery = (
    repo: string,
    listed: readonly TargetIssue[],
    free: number,
    signal: AbortSignal,
  ): number => {
    let ordered = 0;
    for (const found of [...listed].sort((one, other) => one.number - other.number)) {
      if (ordered === free || signal.aborted) break;
      if (!isBreweryOrder(found, log.state(), authors)) continue;
      const batchId = nextBatchId(log.state(), found.number);
      if (issue({ kind: 'order', batchId, order: { issue: found.number } })) {
        ordered++;
        report({ kind: 'ordered', repo, issue: found.number, batchId });
      }
    }
    return ordered;
  };

  // The batches reported as not routable, with the reason: each once, not at every poll.
  const unroutable = new Set<string>();
  const notRouted = (batchId: string, reason: string): void => {
    const key = `${batchId}\n${reason}`;
    if (unroutable.has(key)) return;
    unroutable.add(key);
    report({ kind: 'unrouted', batchId, reason });
  };

  /**
   * Routes every Ordered batch whose Brewery issue `listed` has, by its one `recipe:<name>` label,
   * whoever ordered it (ADR 0068). `listed`: the Brewery's issues read in this pass.
   */
  const route = (listed: readonly TargetIssue[]): void => {
    for (const batch of log.state().batches.values()) {
      if (batch.lane.kind !== 'ordered') continue;
      const number = breweryIssueOf(log.state(), batch);
      const read = listed.find((each) => each.number === number);
      const names = recipeLabels(read?.labels ?? []);
      // No recipe label: it waits for its deadline, then a person chooses (ADR 0032).
      if (names.length === 0) continue;
      const [recipe] = names;
      if (names.length > 1 || recipe === undefined) {
        const all = names.map((name) => `recipe:${name}`).join(' and ');
        notRouted(batch.id, `its issue #${number} carries ${all}; give it one recipe label`);
        continue;
      }
      const command = {
        kind: 'route',
        batchId: batch.id,
        recipe,
        reason: `the label recipe:${recipe}`,
        source: 'label',
      } as const;
      const decision = log.issue(command, clock());
      if (decision.kind === 'accepted') report({ kind: 'routed', batchId: batch.id, recipe });
      else notRouted(batch.id, decision.reason);
    }
  };

  /** Whether an Ordered batch waits for the Brewery's issues to be routed by. */
  const awaitsRouting = (): boolean => {
    const state = log.state();
    return [...state.batches.values()].some(
      (batch) => batch.lane.kind === 'ordered' && breweryIssueOf(state, batch) !== undefined,
    );
  };

  const work = async (signal: AbortSignal): Promise<void> => {
    await recordEnds(signal);
    let free = freeCapacity(log.state(), capacity);
    // The Brewery's issues read in this pass, for routing: target issues never route (ADR 0156).
    let listed: readonly TargetIssue[] = [];
    // The Brewery's own issues first: its owners' requests, before a shared queue (ADR 0068).
    if (brewery !== undefined && (free > 0 || awaitsRouting())) {
      try {
        listed = await tracker.issues(brewery, undefined, signal);
        free -= orderBrewery(brewery, listed, free, signal);
      } catch (error) {
        report({ kind: 'failed', what: `listing ${brewery}`, error });
      }
    }
    for (const repository of repositories) {
      if (signal.aborted || free === 0) break;
      const { repo, filter } = repository;
      try {
        free -= await claimIn(repository, await tracker.issues(repo, filter, signal), free, signal);
      } catch (error) {
        report({ kind: 'failed', what: `claiming in ${repo}`, error });
      }
    }
    // A pass given up at its deadline routes nothing.
    if (!signal.aborted) route(listed);
  };

  /** Runs one pass until `deadlineMs`, then aborts its signal, reports it and settles. */
  const pass = async (): Promise<void> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        const error = new Error(
          `The intake pass took longer than its deadline of ${deadlineMs} ms`,
        );
        controller.abort(error);
        report({ kind: 'failed', what: 'the pass', error });
        resolve();
      }, deadlineMs);
    });
    const working = work(controller.signal);
    // What it does after the deadline is no longer awaited: never an unhandled rejection.
    working.catch(() => {});
    try {
      await Promise.race([working, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  // One pass at a time, whoever calls: two would both find a claim of the first as their own and
  // order the issue twice.
  let passing: Promise<unknown> = Promise.resolve();
  return {
    poll: () => {
      const next = passing.then(pass);
      passing = next.catch(() => {});
      return next;
    },
  };
};
