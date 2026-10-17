// `foedrum serve`, the Cellar (ADR 0063): takes the driver lock `cellar`, opens the event store and
// the state branch, each repository's attempt worktrees and the driver with the real runner, the
// attempt plans and the claim effects, ticks the driver until Ctrl+C with the intake polling beside
// the ticks (ADR 0068), and closes it all again. The machine comes in through `ServeShell`;
// serve-main.ts gives it the real one.

import { createAttemptPlans } from '../brewers/attempt-plans.ts';
import { attemptSettingsCleaner } from '../brewers/attempt-settings-cleanup.ts';
import type { ClaudeAttemptPlan } from '../brewers/claude-runner.ts';
import type { AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import { claimEffects } from '../engine/claim-effects.ts';
import { createCommandLog } from '../engine/command-log.ts';
import type { EngineCommand } from '../engine/decide.ts';
import {
  type Driver,
  type DriverNotice,
  openDriver,
  type RepositoryWorktrees,
} from '../engine/driver.ts';
import type { DriverLock } from '../engine/driver-lock.ts';
import { effectKey } from '../engine/effect-key.ts';
import type { EventStore } from '../engine/event-store.ts';
import { createIntake, type IntakeNotice } from '../engine/intake.ts';
import type { Claimant } from '../engine/issue-claims.ts';
import { StateBranchStopError } from '../engine/state-branch.ts';
import type { StateBranch } from '../engine/state-branch-git.ts';
import { githubClaimHost } from '../github/claims.ts';
import { createGitHubClient, GitHubRateLimited } from '../github/client.ts';
import { githubLogin } from '../github/login.ts';
import { githubIssueMarks } from '../github/marks.ts';
import { githubOrderText } from '../github/order-text.ts';
import { createGitHubReads } from '../github/reads.ts';
import { githubTargetTracker } from '../github/tracker.ts';
import type { AttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import { printable } from './run.ts';
import type { ServeRepository, ServeSetup } from './serve-config.ts';

/** What serve needs from the machine. */
export interface ServeShell {
  /** Prints one line. */
  out: (line: string) => void;
  /** Aborts on Ctrl+C: serve stops after the tick underway. */
  signal: AbortSignal;
  clock: () => Date;
  /** Waits `ms`, or less once `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  lock: (workRoot: string, options: { brewery: string; owner: string }) => DriverLock;
  /** Opens the event store at `path`, making it when missing. */
  openStore: (path: string) => EventStore;
  stateBranch: (store: EventStore) => Pick<StateBranch, 'start' | 'flush'>;
  /** The attempt worktrees of a repository, making its managed clone first. */
  worktrees: (
    repository: ServeRepository,
  ) => Promise<Pick<AttemptWorktrees, 'root' | 'create' | 'clean'>>;
  /** The brewer runner: `claudeBrewerRunner` with `claude` and the plans. */
  runner: (
    claude: string,
    plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>,
  ) => BrewerRunner;
  /** Default the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** How long an intake pass may take; default half the batch lease (ADR 0050). */
  intakeDeadlineMs?: number;
  /** How long between ticks; default 5 s, the supervisor's interval (ADR 0027). */
  intervalMs?: number;
}

/** The Cellar's driver owner (ADR 0037). */
const OWNER = 'cellar';
/** The supervisor's interval (ADR 0027). */
const INTERVAL_MS = 5000;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A command as a notice names it: its kind, and its batch when it has one. */
const commandName = (command: EngineCommand): string => {
  const batchId =
    'batchId' in command
      ? command.batchId
      : 'batchId' in command.event
        ? command.event.batchId
        : undefined;
  return batchId === undefined ? command.kind : `${command.kind} of batch ${batchId}`;
};

/** A driver's notice as one line. */
export const formatNotice = (notice: DriverNotice): string => {
  switch (notice.kind) {
    case 'refused':
      return `${commandName(notice.command)} was refused: ${notice.reason}`;
    case 'command_failed':
      return `${commandName(notice.command)} failed: ${messageOf(notice.error)}`;
    case 'flush_failed':
      return `the state branch was not pushed: ${notice.reason}`;
    case 'flush_overdue':
      return `the state branch has not been pushed since ${notice.since.toISOString()}`;
    case 'tick_failed':
      return `a tick failed: ${messageOf(notice.error)}`;
    case 'batch_lost':
      return `batch ${notice.batchId} is driven by ${notice.holder.owner} now`;
    case 'effect_failed':
      return `the effect ${effectKey.encode(notice.key)} failed: ${messageOf(notice.error)}`;
    case 'cleaned': {
      const { done, kept, failed } = notice.report;
      const lines = [...done, ...kept, ...failed];
      return `cleaned batch ${notice.batchId}: ${lines.length === 0 ? 'nothing to remove' : lines.join('; ')}`;
    }
    default: {
      const unknown: never = notice;
      throw new Error(`Unknown notice ${JSON.stringify(unknown)}`);
    }
  }
};

/** An intake's notice as one line (ADR 0068). */
export const formatIntakeNotice = (notice: IntakeNotice): string => {
  switch (notice.kind) {
    case 'ordered':
      return `ordered ${notice.repo}#${notice.issue} as batch ${notice.batchId}`;
    case 'routed':
      return `routed batch ${notice.batchId} to the recipe ${notice.recipe}`;
    case 'unrouted':
      return `batch ${notice.batchId} is not routed: ${notice.reason}`;
    case 'taken':
      return `${notice.repo}#${notice.issue} is claimed by ${notice.by ?? 'a ref whose record cannot be read'}`;
    case 'refused':
      return `${commandName(notice.command)} was refused: ${notice.reason}`;
    case 'failed':
      return `the intake failed ${notice.what}: ${messageOf(notice.error)}`;
    default: {
      const unknown: never = notice;
      throw new Error(`Unknown notice ${JSON.stringify(unknown)}`);
    }
  }
};

/** Runs the Cellar until `shell.signal` aborts; the exit code: 0 stopped, 1 failed. */
export const runServe = async (setup: ServeSetup, shell: ServeShell): Promise<number> => {
  const { out, signal, clock, wait, intervalMs = INTERVAL_MS } = shell;
  // Notices may carry text a model wrote: never a control character on the terminal.
  const say = (line: string): void => out(printable(`foedrum serve: ${line}`));
  // The lock first: a second Cellar is refused before it touches the store or the state branch.
  let lock: DriverLock;
  try {
    lock = shell.lock(setup.workRoot, { brewery: setup.brewery, owner: OWNER });
  } catch (error) {
    say(messageOf(error));
    return 1;
  }
  let store: EventStore | undefined;
  let driver: Driver | undefined;
  let polling: Promise<void> | undefined;
  try {
    store = shell.openStore(setup.store);
    // Rebuilds or catches up the store from the branch (ADR 0011, ADR 0024).
    const stateBranch = shell.stateBranch(store);
    await stateBranch.start();
    const worktrees: RepositoryWorktrees[] = [];
    for (const repository of setup.repositories) {
      const { repo, base } = repository;
      worktrees.push({ repo, base, manager: await shell.worktrees(repository) });
    }
    const client = createGitHubClient({
      token: setup.github.token,
      baseUrl: setup.github.api,
      // GitHub's rate-limit pause runs on serve's clock, which also decides when to poll.
      now: () => clock().getTime(),
      ...(shell.fetch === undefined ? {} : { fetch: shell.fetch }),
    });
    // One cache of conditional reads for the intake, the marks and the orders' text (ADR 0052).
    const reads = createGitHubReads(client);
    const claims = githubClaimHost(client);
    // The claims and their marks need the token's login; a Brewery that claims nothing does not.
    // A claimed batch the store has keeps its marks and release due, intake or not (ADR 0050).
    let claimant: Claimant = { brewery: setup.brewery, login: '' };
    let effects: ReturnType<typeof claimEffects> | undefined;
    const claimed = [
      ...createCommandLog({ store, recipes: setup.recipes }).state().batches.values(),
    ].some((batch) => batch.repo !== undefined);
    if (setup.intake.repositories.length > 0 || claimed) {
      const login = await githubLogin(client, signal);
      claimant = { brewery: setup.brewery, login };
      effects = claimEffects({
        claimant,
        marks: githubIssueMarks({ client, reads, login }),
        claims,
      });
    }
    const tools = new Map(setup.repositories.map(({ repo, tools }) => [repo.toLowerCase(), tools]));
    let opened: Driver | undefined;
    const plans = createAttemptPlans({
      state: () => {
        if (opened === undefined) throw new Error('the driver is not open yet');
        return opened.state();
      },
      brewers: setup.brewers,
      models: setup.models,
      repoTools: (repo) => tools.get(repo.toLowerCase()) ?? [],
      sandbox: setup.sandbox,
      workRoot: setup.workRoot,
      env: setup.brewerEnv,
      orderText: githubOrderText(reads, setup.brewery),
    });
    driver = await openDriver({
      store,
      runner: shell.runner(setup.claude, plans.plan),
      recipes: setup.recipes,
      clock,
      lock: () => lock,
      // The Cellar takes every free batch (ADR 0044).
      takes: () => true,
      stateBranch,
      limits: plans.limits,
      worktrees,
      alsoCleans: [attemptSettingsCleaner(setup.workRoot)],
      ...(effects === undefined ? {} : { effects }),
      report: (notice) => say(formatNotice(notice)),
    });
    opened = driver;
    // GitHub's rate limit holds requests until then: no pass starts before it (ADR 0052).
    let pausedUntil = 0;
    const intake = createIntake({
      // A second writer on the store, as a terminal command is (ADR 0044).
      log: createCommandLog({ store, recipes: setup.recipes }),
      brewery: setup.brewery,
      tracker: githubTargetTracker(reads),
      claims,
      claimant,
      authors: setup.intake.users,
      repositories: setup.intake.repositories,
      capacity: setup.intake.capacity,
      clock,
      report: (notice) => {
        if (notice.kind === 'failed' && notice.error instanceof GitHubRateLimited) {
          pausedUntil = Math.max(pausedUntil, notice.error.until.getTime());
        }
        say(formatIntakeNotice(notice));
      },
      ...(shell.intakeDeadlineMs === undefined ? {} : { deadlineMs: shell.intakeDeadlineMs }),
    });
    // The pass underway, never awaited by a tick: a slow GitHub holds off no heartbeat (ADR 0068).
    let nextPoll = Number.NEGATIVE_INFINITY;
    const poll = (): void => {
      const at = clock().getTime();
      if (polling !== undefined || at < nextPoll || at < pausedUntil) return;
      nextPoll = at + setup.intake.pollEveryMs;
      polling = intake
        .poll()
        .catch((error: unknown) =>
          say(formatIntakeNotice({ kind: 'failed', what: 'a pass', error })),
        )
        .finally(() => {
          polling = undefined;
        });
    };
    say(`brewing for ${setup.brewery} in ${setup.workRoot}; Ctrl+C stops it`);
    while (!signal.aborted) {
      poll();
      try {
        await driver.tick();
      } catch (error) {
        if (error instanceof StateBranchStopError) throw error;
        say(formatNotice({ kind: 'tick_failed', error }));
      }
      if (signal.aborted) break;
      await wait(intervalMs, signal);
    }
    // Its deadline bounds the wait.
    await polling;
    say('stopped');
    return 0;
  } catch (error) {
    say(messageOf(error));
    return 1;
  } finally {
    // The pass underway writes to the store until it settles.
    await polling;
    // Closing the driver stops its runs and lets the lock go; without one, the lock goes here.
    if (driver === undefined) lock.release();
    else driver.close();
    store?.close();
  }
};
