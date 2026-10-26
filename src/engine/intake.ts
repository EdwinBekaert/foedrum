// The intake (ADR 0008, ADR 0043, ADR 0068). One pass, in this order:
// - records the end of each pull request of a batch on tap that merged or closed
//   (`pull_request.ended`), the fact a claimed batch's release waits for (ADR 0198);
// - records the checks on each open pull request's head: since when it waits for them, and how
//   each one finished once they all have (ADR 0213);
// - checks each open pull request whose base's tip moved against that tip (ADR 0198);
// - walks one queue, in rank order (ADR 0208) and only up to the Brewery's free capacity: the
//   Brewery's own issues that carry a `recipe:<name>` label, which it orders as `<issue>-1`, the
//   ready sub-orders of its orders, which it orders as `<issue>-1` under their order's batch
//   (ADR 0211), and the candidates of each repository with an intake filter, which it claims and
//   orders as `<alias>-<issue>`, each Ordered until it is routed by its deadline (ADR 0032),
//   skipping what a recipe's `concurrency` or the open-order limit holds (ADR 0217);
// - routes every Ordered batch whose Brewery issue it read by that issue's one `recipe:<name>`
//   label, whoever ordered it: this pass, a pass killed before it routed, or a retry. A claimed
//   batch's Brewery issue is its order (ADR 0144, ADR 0156), never the target issue. A batch
//   whose recipe brews its `concurrency` waits Ordered (ADR 0217).
// Everything it reads from the tracker is untrusted input; it decides nothing by asking a model.

import type { BreweryConfig } from '../schemas/brewery-config.ts';
import type { OrderRef } from '../schemas/events.ts';
import { type BaseCheckRepository, checkBases } from './base-check.ts';
import { nextBatchId, targetBatchId } from './batch-id.ts';
import { defaultLeaseMs } from './batch-leases.ts';
import { breweryIssueOf, claimOfOrder } from './claim-orders.ts';
import type { CommandLog } from './command-log.ts';
import type { EngineCommand } from './decide.ts';
import { type Batch, emptyState, orderKey, type State } from './fold.ts';
import {
  type Claimant,
  type ClaimHost,
  type ClaimOutcome,
  claimIssue,
  type IntakeFilter,
  isCandidate,
  type PullRequestState,
  same,
  type TargetIssue,
} from './issue-claims.ts';
import { holdText, type Limits, routeHold, startTally } from './limits.ts';
import { type PullRequestCheckReader, recordChecks } from './pr-checks.ts';
import { sentBackFrom } from './pull-request-fix.ts';
import { hasSubOrdersLeft, type QueuedOrder, rankQueue } from './ranks.ts';
import { readySubOrders } from './ready-set.ts';
import type { ReleaseReader } from './releases.ts';

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
  /** An issue of the queue a limit holds (ADR 0217); reported once per issue and reason. */
  | { kind: 'held'; repo: string; issue: number; reason: string }
  /** A release of a repository a `release` blocker waits on, recorded (ADR 0223). */
  | { kind: 'released'; repo: string; version: string }
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
  /** In the order the Brewery's config names them, which breaks a tie of arrival (ADR 0208). */
  repositories: readonly IntakeRepository[];
  /** How many batches may be Ordered or Brewing at once. */
  capacity: number;
  /** A recipe's `concurrency` and the open-order limit (ADR 0217); none by default. */
  limits?: Limits;
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
  /**
   * What reads the checks on each open pull request's head, which each pass records once they
   * finish (ADR 0213); none by default.
   */
  checks?: PullRequestCheckReader;
  /**
   * What reads the latest release of each repository a `release` blocker waits on, which each pass
   * records once it holds the blockers' merges (ADR 0223); none by default.
   */
  releases?: ReleaseReader;
}

/** No recipe's concurrency and no open-order limit: only the Brewery's free capacity holds. */
const NO_LIMITS: Limits = { openOrders: Number.POSITIVE_INFINITY, recipe: () => undefined };

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

/** A repository's open issues, as a pass listed them: none when it could not. */
export interface Listing {
  repository: IntakeRepository;
  issues: readonly TargetIssue[];
}

/** An order of the pass's queue: a Brewery issue, or a target issue of `repository`. */
export interface QueuedIssue extends QueuedOrder {
  repository?: IntakeRepository;
}

/**
 * The ready sub-orders the intake would order (ADR 0211), each at its order's arrival and in its
 * plan's order: only while `listed` shows the order's issue and its own open, since a person who
 * closed either has dropped it.
 */
const subOrdersQueued = (state: State, listed: readonly TargetIssue[]): QueuedIssue[] => {
  const open = new Map(
    listed
      .filter((found) => found.state === 'open' && !found.pullRequest)
      .map((found) => [found.number, found]),
  );
  return readySubOrders(state).flatMap(({ order, issue, parentBatchId }) => {
    const created = open.get(order)?.created;
    if (created === undefined || !open.has(issue)) return [];
    return [{ order: { issue: order }, created, source: 0, subOrder: { issue, parentBatchId } }];
  });
};

/**
 * The queue of one pass in rank order (ADR 0208): the Brewery's issues the intake would order, the
 * ready sub-orders of its orders (ADR 0211) and the target issues it would claim, of
 * `repositories` in the order foedrum.jsonc lists them. `placed`: an order with sub-orders left
 * but none ready, which `rank` places at its arrival though no pass would order it now.
 */
export const intakeQueue = (
  state: State,
  listed: { brewery: readonly TargetIssue[]; repositories: readonly Listing[] },
  who: { authors: readonly string[]; claimant: Claimant },
  placed?: OrderRef,
): QueuedIssue[] => {
  const { authors, claimant } = who;
  const orders: QueuedIssue[] = listed.brewery
    .filter((found) => isBreweryOrder(found, state, authors))
    .map((found) => ({ order: { issue: found.number }, created: found.created, source: 0 }));
  orders.push(...subOrdersQueued(state, listed.brewery));
  if (placed !== undefined && hasSubOrdersLeft(state, placed)) {
    const found = listed.brewery.find((each) => each.number === placed.issue);
    const queued = orders.some(({ order }) => orderKey(order) === orderKey(placed));
    if (found?.state === 'open' && !queued) {
      orders.push({ order: { issue: placed.issue }, created: found.created, source: 0 });
    }
  }
  listed.repositories.forEach(({ repository, issues }, index) => {
    const { repo, filter } = repository;
    const brewed = new Set(
      [...state.batches.values()]
        .filter((batch) => batch.repo !== undefined && same(batch.repo, repo))
        .map((batch) => batch.issue),
    );
    for (const found of issues) {
      if (!isCandidate(found, { filter, claimant, brewed, authors })) continue;
      const order = { issue: found.number, repo };
      orders.push({ order, created: found.created, source: index + 1, repository });
    }
  });
  // Once each: a listing whose pages shift while it is read can return an issue twice.
  const seen = new Set<string>();
  const once = orders.filter(({ order, subOrder }) => {
    const key = `${orderKey(order)} ${subOrder?.issue ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rankQueue(once, state.ranks);
};

export const createIntake = (options: IntakeOptions): Intake => {
  const { log, brewery, tracker, claims, claimant, authors, repositories, capacity, clock } =
    options;
  const most = defaultLeaseMs / 2;
  const { deadlineMs = most, bases = [], checks, limits = NO_LIMITS } = options;
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

  /**
   * Records the end of each pull request of a batch on tap that merged or closed: a Brewery
   * issue's too, so its base is checked no more (ADR 0198); and of the pull request a batch brews
   * a fix of, Stuck or not, so its action pushes nothing to it (ADR 0219).
   */
  const endable = (batch: Batch): readonly string[] => {
    const { lane } = batch;
    if (lane.kind === 'on_tap') return lane.pullRequests;
    return lane.kind === 'brewing' || lane.kind === 'stuck' ? [...sentBackFrom(batch)] : [];
  };
  const recordEnds = async (signal: AbortSignal): Promise<void> => {
    for (const batch of log.state().batches.values()) {
      for (const pullRequest of endable(batch)) {
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

  /**
   * Orders up to `free` of the pass's queue in rank order (ADR 0208): a Brewery issue as it is, a
   * target issue once this Brewery holds its claim. A claim another Brewery holds costs no
   * capacity; a claim the code host fails ends that repository's claims for this pass, since the
   * cause is likely a rate limit or lost access, not one issue, and the next pass tries again.
   */
  const orderQueue = async (
    breweryIssues: readonly TargetIssue[],
    free: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const listings: Listing[] = [];
    for (const repository of repositories) {
      if (signal.aborted) return;
      const { repo, filter } = repository;
      try {
        listings.push({ repository, issues: await tracker.issues(repo, filter, signal) });
      } catch (error) {
        report({ kind: 'failed', what: `claiming in ${repo}`, error });
        listings.push({ repository, issues: [] });
      }
    }
    const queue = intakeQueue(
      log.state(),
      { brewery: breweryIssues, repositories: listings },
      { authors, claimant },
    );
    const failed = new Set<IntakeRepository>();
    const now = clock().toISOString();
    // What a limit holds is skipped, keeps its place, and the walk goes on (ADR 0217).
    const tally = startTally(log.state(), breweryIssues, limits);
    let ordered = 0;
    for (const entry of queue) {
      const { order, repository, subOrder } = entry;
      // A pass given up at its deadline orders nothing: the next pass finds its claims as ours.
      if (ordered === free || signal.aborted) break;
      if (repository !== undefined && failed.has(repository)) continue;
      const hold = tally.hold(entry);
      if (hold !== undefined) {
        heldOnce({
          repo: repository?.repo ?? brewery ?? '',
          issue: subOrder?.issue ?? order.issue,
          reason: holdText(hold),
        });
        continue;
      }
      if (repository === undefined) {
        // A ready sub-order is ordered under its order's batch (ADR 0211).
        const number = subOrder?.issue ?? order.issue;
        const batchId = nextBatchId(log.state(), number);
        const parent = subOrder === undefined ? {} : { parentBatchId: subOrder.parentBatchId };
        if (issue({ kind: 'order', batchId, order: { issue: number }, ...parent })) {
          ordered++;
          tally.start(entry);
          report({ kind: 'ordered', repo: brewery ?? '', issue: number, batchId });
        }
        continue;
      }
      const { repo, alias } = repository;
      let outcome: ClaimOutcome;
      try {
        signal.throwIfAborted();
        outcome = await claimIssue(claims, {
          repo,
          issue: order.issue,
          brewery: claimant.brewery,
          now,
          signal,
        });
      } catch (error) {
        failed.add(repository);
        report({ kind: 'failed', what: `claiming ${repo}#${order.issue}`, error });
        continue;
      }
      switch (outcome.kind) {
        case 'won':
        case 'ours': {
          if (signal.aborted) return;
          const batchId = targetBatchId(log.state(), alias, order.issue);
          if (issue({ kind: 'order', batchId, order: { issue: order.issue, repo } })) {
            ordered++;
            tally.start(entry);
            report({ kind: 'ordered', repo, issue: order.issue, batchId });
          }
          break;
        }
        case 'taken':
          report({ kind: 'taken', repo, issue: order.issue, by: outcome.by });
          break;
        default:
          outcome satisfies never;
      }
    }
  };

  // The issues reported as held, with the reason: each once, not at every poll (ADR 0217).
  const holding = new Set<string>();
  const heldOnce = (held: { repo: string; issue: number; reason: string }): void => {
    const key = `${held.repo}#${held.issue}\n${held.reason}`;
    if (holding.has(key)) return;
    holding.add(key);
    report({ kind: 'held', ...held });
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
      // A claimed batch or a retry, whose recipe the walk could not see: it waits (ADR 0217).
      const hold = routeHold(log.state(), recipe, limits);
      if (hold !== undefined) {
        notRouted(batch.id, holdText(hold));
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
    const failed = (what: string, error: unknown): void => report({ kind: 'failed', what, error });
    if (checks !== undefined && !signal.aborted) {
      await recordChecks({ log, reader: checks, clock, failed }, signal);
    }
    if (bases.length > 0 && !signal.aborted) {
      await checkBases({ log, repositories: bases, clock, failed }, signal);
    }
    // pause --all holds the intake: it orders and claims nothing, and still routes (ADR 0202).
    const free = log.state().pauses.all === undefined ? freeCapacity(log.state(), capacity) : 0;
    // The Brewery's issues read in this pass, for routing: target issues never route (ADR 0156).
    let listed: readonly TargetIssue[] = [];
    if (brewery !== undefined && (free > 0 || awaitsRouting())) {
      try {
        listed = await tracker.issues(brewery, undefined, signal);
      } catch (error) {
        report({ kind: 'failed', what: `listing ${brewery}`, error });
      }
    }
    // One queue across the Brewery and every repository, in rank order (ADR 0208).
    if (free > 0 && !signal.aborted) await orderQueue(listed, free, signal);
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
