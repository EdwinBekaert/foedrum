// `foedrum serve`, the Cellar (ADR 0063): takes the driver lock `cellar`, opens the driver on the
// wiring it shares with `foedrum brew` (driver-wiring.ts), ticks it until Ctrl+C with the intake
// polling beside the ticks (ADR 0068), and closes it all again. The machine comes in through
// `ServeShell`; serve-main.ts gives it the real one.

import type { ClaudeAttemptPlan } from '../brewers/claude-runner.ts';
import type { BaseCheckRepository } from '../engine/base-check.ts';
import type { WorktreeMerge } from '../engine/base-merge.ts';
import type { AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import { createCommandLog } from '../engine/command-log.ts';
import type { EngineCommand } from '../engine/decide.ts';
import type { DriverNotice } from '../engine/driver.ts';
import type { DriverLock } from '../engine/driver-lock.ts';
import { effectKey } from '../engine/effect-key.ts';
import type { EventStore } from '../engine/event-store.ts';
import { createIntake, type IntakeNotice } from '../engine/intake.ts';
import type { BranchPush, PullRequestRepository } from '../engine/pull-request-actions.ts';
import { StateBranchStopError } from '../engine/state-branch.ts';
import type { StateBranch } from '../engine/state-branch-git.ts';
import { GitHubRateLimited } from '../github/client.ts';
import { githubTargetTracker } from '../github/tracker.ts';
import type { AwakeHold } from '../platform/keep-awake.ts';
import type { ExecProcess } from '../platform/processes.ts';
import { CELLAR_OWNER } from '../schemas/commands.ts';
import type { AttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import type { Git } from '../workspace/git.ts';
import type { MergedTree } from '../workspace/merge-tree-git.ts';
import { closeOpened, messageOf, type Opened, wireDriver } from './driver-wiring.ts';
import { printable } from './run.ts';
import type { ServeRepository, ServeSetup } from './serve-config.ts';

/** The terminal `foedrum brew` keeps a live line on (ADR 0174). */
export interface LiveTerminal {
  /** The terminal's width in characters, when it is known. */
  columns: () => number | undefined;
  /** Calls `handler` when the terminal is resized; the returned function stops it. */
  onResize: (handler: () => void) => () => void;
  /** Clears the current line and leaves the cursor at its start. */
  clear: () => void;
  /** Clears the current line and writes `text` on it, without a line feed. */
  rewrite: (text: string) => void;
}

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
  /**
   * The attempt worktrees of a repository, making its managed clone first; `recreate` gives a
   * resumed attempt the worktree its session ran in back (ADR 0117).
   */
  worktrees: (
    repository: ServeRepository,
  ) => Promise<Pick<AttemptWorktrees, 'root' | 'create' | 'recreate' | 'clean'>>;
  /**
   * The pushes of the openPullRequest action (ADR 0071), from the clone the repository's
   * worktrees are added to: the user's, or the managed one.
   */
  push: (repository: ServeRepository) => BranchPush;
  /**
   * The merge of the base into the worktree of a batch's last check (ADR 0164), in the clone the
   * repository's worktrees are added to.
   */
  merge: (repository: ServeRepository) => WorktreeMerge;
  /**
   * The merge-tree of an open pull request's head and its base's tip (ADR 0198), in the clone the
   * repository's worktrees are added to; absent, no open pull request is checked.
   */
  mergeTree?: (repository: ServeRepository) => BaseCheckRepository['mergeTree'];
  /**
   * A worktree of an open pull request's merged tree, for the checks on it (ADR 0203), in a git
   * directory of Foedrum's own with the clone's objects; absent, no checks run on one.
   */
  mergedTree?: (repository: ServeRepository) => MergedTree;
  /** The brewer runner: `claudeBrewerRunner` with `claude` and the plans. */
  runner: (
    claude: string,
    plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>,
  ) => BrewerRunner;
  /** The process runner the check steps' commands run through (ADR 0069). */
  exec: ExecProcess;
  /** The process runner a repository's setup runs through: the check sandbox, network kept (ADR 0158). */
  setup: ExecProcess;
  /** The process runner gh runs through, for GitHub (ADR 0073). */
  gh: ExecProcess;
  /** git, for the commits red proofs and the testsUnchanged guard read (ADR 0078). */
  git: Git;
  /** How long an intake pass may take; default half the batch lease (ADR 0050). */
  intakeDeadlineMs?: number;
  /** How long between ticks; default 5 s, the supervisor's interval (ADR 0027). */
  intervalMs?: number;
  /** Holds the machine awake while an attempt runs (ADR 0195); absent, nothing does. */
  awake?: AwakeHold;
  /** Present only where `brew` keeps a live line (ADR 0174); `serve` never reads it. */
  terminal?: LiveTerminal;
}

/** The supervisor's interval (ADR 0027). */
export const INTERVAL_MS = 5000;

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
    case 'run_failed': {
      const { batchId, stepId, attempt } = notice.ref;
      return `the run of step ${stepId}#${attempt} of batch ${batchId} failed, so it is blocked on its environment: ${messageOf(notice.error)}`;
    }
    case 'waiting_for_lease': {
      const { batchId, stepId, attempt } = notice.ref;
      return `step ${stepId}#${attempt} of batch ${batchId} waits until the lease of ${stepId}#${notice.waitsFor.attempt} is released; it expires at ${notice.expiresAt.toISOString()} unless it is renewed`;
    }
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

/**
 * The repositories whose open pull requests each intake pass checks against their base (ADR 0198):
 * every one when the shell can merge-tree, which every git Foedrum runs on can (ADR 0200); else none.
 */
const baseChecks = (
  setup: ServeSetup,
  shell: ServeShell,
  pushes: readonly PullRequestRepository[],
): BaseCheckRepository[] => {
  const { mergeTree } = shell;
  if (mergeTree === undefined) return [];
  return pushes.flatMap(({ repo, base, push }) => {
    const repository = setup.repositories.find((each) => each.repo === repo);
    return repository === undefined
      ? []
      : [
          {
            repo,
            base,
            tip: (name, signal) => push.baseTip(name, signal),
            mergeTree: mergeTree(repository),
            branchTip: (branch, signal) => push.remoteTip(branch, signal),
          },
        ];
  });
};

/** Runs the Cellar until `shell.signal` aborts; the exit code: 0 stopped, 1 failed. */
export const runServe = async (setup: ServeSetup, shell: ServeShell): Promise<number> => {
  const { out, signal, clock, wait, intervalMs = INTERVAL_MS } = shell;
  // Notices may carry text a model wrote: never a control character on the terminal.
  const say = (line: string): void => out(printable(`foedrum serve: ${line}`));
  // The lock first: a second Cellar is refused before it touches the store or the state branch.
  let lock: DriverLock;
  try {
    lock = shell.lock(setup.workRoot, { brewery: setup.brewery, owner: CELLAR_OWNER });
  } catch (error) {
    say(messageOf(error));
    return 1;
  }
  const opened: Opened = { lock };
  let polling: Promise<void> | undefined;
  try {
    const { store, driver, reads, claims, claimant, pushes } = await wireDriver(
      setup,
      shell,
      opened,
      {
        // The Cellar takes every free batch (ADR 0044).
        takes: () => true,
        say,
        report: (notice) => say(formatNotice(notice)),
      },
    );
    const bases = baseChecks(setup, shell, pushes);
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
      bases,
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
    // Elsewhere a check runs in an OS sandbox of its own (ADR 0076).
    if (setup.unsandboxedChecks && setup.checks.any()) {
      say(
        'check steps run outside an OS sandbox on native Windows: their commands can run code a brewer wrote, with network and home-folder access (ADR 0076)',
      );
    }
    // A setup runs before brewer attempts too, so also where no recipe has a check step (ADR 0163).
    if (setup.unsandboxedChecks) {
      for (const { repo } of setup.repositories.filter((repository) => repository.setup)) {
        say(
          `${repo}'s setup runs outside an OS sandbox on native Windows, before brewer attempts and check steps: it can run code a brewer wrote, with network and home-folder access (ADR 0163)`,
        );
      }
    }
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
    // A call the stop itself ended, such as gh reading the login at the start, is a stop.
    if (signal.aborted && error === signal.reason) {
      say('stopped');
      return 0;
    }
    say(messageOf(error));
    return 1;
  } finally {
    // The pass underway writes to the store until it settles.
    await polling;
    // Closing the driver stops its runs and lets the lock go; without one, the lock goes here.
    try {
      closeOpened(opened);
    } finally {
      shell.awake?.release();
    }
  }
};
