// `foedrum serve`, the Cellar (ADR 0063): takes the driver lock `cellar`, opens the event store and
// the state branch, each repository's attempt worktrees and the driver with the real runner, the
// attempt plans, the status comments (ADR 0072) and the claim effects, ticks the driver until
// Ctrl+C with the intake polling beside the ticks (ADR 0068), and closes it all again. The machine
// comes in through `ServeShell`; serve-main.ts gives it the real one.

import { createAttemptPlans } from '../brewers/attempt-plans.ts';
import { attemptSettingsCleaner } from '../brewers/attempt-settings-cleanup.ts';
import type { ClaudeAttemptPlan } from '../brewers/claude-runner.ts';
import { createCheckRunner } from '../checks/check-runner.ts';
import { guardPushes } from '../checks/push-guard.ts';
import { needsTestReport } from '../checks/red-proof.ts';
import { notedClaims, notedPush, remoteWrites } from '../checks/remote-writes.ts';
import { guardTests } from '../checks/tests-guard.ts';
import type { AttemptRef } from '../engine/attempt-key.ts';
import type { AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import { claimEffects } from '../engine/claim-effects.ts';
import { createCommandLog } from '../engine/command-log.ts';
import type { EngineCommand } from '../engine/decide.ts';
import {
  type Driver,
  type DriverNotice,
  openDriver,
  type RepositoryWorktrees,
  repositoryOf,
} from '../engine/driver.ts';
import type { DriverLock } from '../engine/driver-lock.ts';
import { effectKey } from '../engine/effect-key.ts';
import { combineEffects } from '../engine/effects.ts';
import type { EventStore } from '../engine/event-store.ts';
import { createIntake, type IntakeNotice } from '../engine/intake.ts';
import type { Claimant } from '../engine/issue-claims.ts';
import { keepOutDocs } from '../engine/kept-out-docs.ts';
import {
  type BranchPush,
  type PullRequestRepository,
  pullRequestActions,
} from '../engine/pull-request-actions.ts';
import { StateBranchStopError } from '../engine/state-branch.ts';
import { STATE_BRANCH, type StateBranch } from '../engine/state-branch-git.ts';
import { statusEffects } from '../engine/status-comment.ts';
import { stepRunner } from '../engine/step-runner.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { githubClaimHost } from '../github/claims.ts';
import { createGitHubClient, GitHubRateLimited } from '../github/client.ts';
import { githubLogin } from '../github/login.ts';
import { githubIssueMarks } from '../github/marks.ts';
import { githubOrderText, githubOrderTitle } from '../github/order-text.ts';
import { githubPullRequests } from '../github/pull-requests.ts';
import { createGitHubReads } from '../github/reads.ts';
import { githubStatusComments } from '../github/status-comments.ts';
import { githubTargetTracker } from '../github/tracker.ts';
import type { ExecProcess } from '../platform/processes.ts';
import { type AttemptWorktrees, worktreeClonePath } from '../workspace/attempt-worktrees-git.ts';
import type { Git } from '../workspace/git.ts';
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
  /**
   * The pushes of the openPullRequest action (ADR 0071), from the clone the repository's
   * worktrees are added to: the user's, or the managed one.
   */
  push: (repository: ServeRepository) => BranchPush;
  /**
   * The refs of the repository on GitHub, as `ls-remote --refs` lists them, read from a git
   * directory of Foedrum's own (ADR 0096): what the noPush guard compares (ADR 0106).
   */
  refs: (repository: ServeRepository) => (signal: AbortSignal) => Promise<string>;
  /** The brewer runner: `claudeBrewerRunner` with `claude` and the plans. */
  runner: (
    claude: string,
    plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>,
  ) => BrewerRunner;
  /** The process runner the check steps' commands run through (ADR 0069). */
  exec: ExecProcess;
  /** The process runner gh runs through, for GitHub (ADR 0073). */
  gh: ExecProcess;
  /** git, for the commits red proofs and the testsUnchanged guard read (ADR 0078). */
  git: Git;
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
    case 'run_failed': {
      const { batchId, stepId, attempt } = notice.ref;
      return `the run of step ${stepId}#${attempt} of batch ${batchId} failed, so it is blocked on its environment: ${messageOf(notice.error)}`;
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
    const pushes: PullRequestRepository[] = [];
    // The engine's own writes to the remotes, which the noPush guard leaves out (ADR 0106).
    const writes = remoteWrites();
    for (const repository of setup.repositories) {
      const { repo, base } = repository;
      worktrees.push({ repo, base, manager: await shell.worktrees(repository) });
      // The pull request goes into the branch the attempts start from (ADR 0071).
      const into = base.slice(base.indexOf('/') + 1);
      pushes.push({ repo, base: into, push: notedPush(shell.push(repository), writes, repo) });
    }
    const client = createGitHubClient({
      exec: shell.gh,
      hostname: setup.github.hostname,
      // GitHub's rate-limit pause runs on serve's clock, which also decides when to poll.
      now: () => clock().getTime(),
    });
    // One cache of conditional reads for the intake, the marks and the orders' text (ADR 0052).
    const reads = createGitHubReads(client);
    const claims = notedClaims(githubClaimHost(client), writes);
    // gh's login: the status comments and the claim marks count only its own (ADR 0072, ADR 0073).
    const login = await githubLogin(client, signal);
    const claimant: Claimant = { brewery: setup.brewery, login };
    const status = statusEffects({
      brewery: setup.brewery,
      comments: githubStatusComments({ client, reads, login }),
      recipes: setup.recipes,
      clock,
    });
    // A claimed batch the store has keeps its marks and release due, intake or not (ADR 0050).
    const claimed = [
      ...createCommandLog({ store, recipes: setup.recipes }).state().batches.values(),
    ].some((batch) => batch.repo !== undefined);
    const effects =
      setup.intake.repositories.length > 0 || claimed
        ? combineEffects(
            status,
            claimEffects({ claimant, marks: githubIssueMarks({ client, reads, login }), claims }),
          )
        : status;
    // The login was read at the start, for the status comments (ADR 0072).
    const actions = pullRequestActions({
      brewery: setup.brewery,
      repositories: pushes,
      host: githubPullRequests({ client, reads, login: async () => login }),
      orderTitle: githubOrderTitle(reads, setup.brewery),
    });
    const tools = new Map(setup.repositories.map(({ repo, tools }) => [repo.toLowerCase(), tools]));
    let opened: Driver | undefined;
    const state = () => {
      if (opened === undefined) throw new Error('the driver is not open yet');
      return opened.state();
    };
    const repositoryNamed = (repo: string) =>
      setup.repositories.find((repository) => sameRepo(repository.repo, repo));
    // The clone a repository's worktrees are added to: where git reads an attempt's commits, never
    // its worktree (ADR 0074, ADR 0078).
    const repositoryCalled = (repo: string) => {
      const repository = repositoryNamed(repo);
      if (repository === undefined) throw new Error(`${repo} is no repository of this Brewery`);
      return repository;
    };
    const clone = (repo: string) => worktreeClonePath(setup.workRoot, repositoryCalled(repo));
    const plans = createAttemptPlans({
      state,
      brewers: setup.brewers,
      models: setup.models,
      repoTools: (repo) => tools.get(repo.toLowerCase()) ?? [],
      // Where a commit-producing attempt's commits are counted (ADR 0074).
      clone,
      sandbox: setup.sandbox,
      workRoot: setup.workRoot,
      env: setup.brewerEnv,
      orderText: githubOrderText(reads, setup.brewery),
    });
    // A check step's commands run in the brewers' environment, without a token variable (ADR 0069);
    // as the same OS user they can still start gh, which answers from its login (ADR 0073, #204).
    const checks = createCheckRunner({
      state,
      checks: setup.checks,
      repositoryChecks: (repo) => repositoryNamed(repo)?.checks,
      testReport: (repo) => repositoryNamed(repo)?.testReport,
      exec: shell.exec,
      git: shell.git,
      clone,
      env: setup.brewerEnv,
      clock,
    });
    const recipeOf = (batchId: string) => state().batches.get(batchId)?.recipe?.name;
    const guardsOf = (batchId: string, stepId: string) =>
      setup.brewers.find(recipeOf(batchId) ?? '', stepId)?.brewer.guards ?? [];
    // The brewer of a step with the testsUnchanged guard keeps the red proof's tests (ADR 0078),
    // and one with noPush leaves the remote as it found it (ADR 0106).
    const brewer = guardPushes({
      runner: guardTests({
        runner: shell.runner(setup.claude, plans.plan),
        state,
        protects: ({ batchId, stepId }) =>
          guardsOf(batchId, stepId).includes('testsUnchanged')
            ? setup.checks.redProof(recipeOf(batchId) ?? '')?.of
            : undefined,
        git: shell.git,
        clone,
        clock,
      }),
      state,
      guarded: ({ batchId, stepId }) => guardsOf(batchId, stepId).includes('noPush'),
      refs: async (repo, signal) => shell.refs(repositoryCalled(repo))(signal),
      writes,
      // Its own push refuses a move the engine did not make (ADR 0024).
      exempt: (repo, ref) => sameRepo(repo, setup.brewery) && ref === `refs/heads/${STATE_BRANCH}`,
      // Ctrl+C: no git of the guard outlives serve.
      signal,
      clock,
    });
    const isCheck = ({ batchId, stepId }: AttemptRef) => {
      const recipe = recipeOf(batchId);
      return recipe !== undefined && setup.checks.find(recipe, stepId) !== undefined;
    };
    const runner = stepRunner({
      brewer,
      check: checks,
      isCheck,
      // A batch whose red proof would run needs its repository's test report from the start, so
      // no brewer spends tokens on a batch that cannot prove its tests red (ADR 0017).
      refuse: ({ batchId }) => {
        const current = state();
        const batch = current.batches.get(batchId);
        const name = batch?.recipe?.name;
        const proof = name === undefined ? undefined : setup.checks.redProof(name);
        if (batch === undefined || name === undefined || proof === undefined) return undefined;
        if (setup.recipes.find(name)?.skip(batch, proof.id) !== undefined) return undefined;
        let repo: string;
        try {
          repo = repositoryOf(current, batchId, worktrees).repo;
        } catch {
          // The driver fails the attempt with the reason when it makes its worktree.
          return undefined;
        }
        return repositoryNamed(repo)?.testReport === undefined
          ? needsTestReport(name, repo)
          : undefined;
      },
    });
    driver = await openDriver({
      store,
      // Each out doc read is kept for the state branch before its step.finished (ADR 0103).
      runner: keepOutDocs({
        runner,
        store,
        report: (error, { batchId, stepId, attempt }) =>
          say(
            `the out doc of ${batchId} ${stepId}#${attempt} was not kept for the state branch: ${messageOf(error)}`,
          ),
      }),
      recipes: setup.recipes,
      clock,
      lock: () => lock,
      // The Cellar takes every free batch (ADR 0044).
      takes: () => true,
      stateBranch,
      limits: plans.limits,
      outDoc: plans.outDoc,
      worktrees,
      // A check step runs no claude, so it has no session (ADR 0116).
      brews: (ref) => !isCheck(ref),
      alsoCleans: [attemptSettingsCleaner(setup.workRoot)],
      effects,
      actions,
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
    // Elsewhere a check runs in an OS sandbox of its own (ADR 0076).
    if (setup.unsandboxedChecks && setup.checks.any()) {
      say(
        'check steps run outside an OS sandbox on native Windows: their commands can run code a brewer wrote, with network and home-folder access (ADR 0076)',
      );
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
    if (driver === undefined) lock.release();
    else driver.close();
    store?.close();
  }
};
