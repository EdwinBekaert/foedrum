// The wiring a driver on the real machine runs on (ADR 0063, ADR 0123), shared by `foedrum serve`
// and `foedrum brew`: under a lock the caller took, it opens the event store and the state branch,
// each repository's attempt worktrees, GitHub through gh, the status comments (ADR 0072) and the
// claim effects, the attempt plans, the check runner and the guards, and the driver with the real
// runner. Each caller says which batches its driver takes.

import { createAttemptPlans } from '../brewers/attempt-plans.ts';
import { attemptSettingsCleaner } from '../brewers/attempt-settings-cleanup.ts';
import { createCheckRunner } from '../checks/check-runner.ts';
import { guardPushes } from '../checks/push-guard.ts';
import { needsTestReport } from '../checks/red-proof.ts';
import { notedClaims, notedPush, remoteWrites } from '../checks/remote-writes.ts';
import { guardTests } from '../checks/tests-guard.ts';
import type { AttemptRef } from '../engine/attempt-key.ts';
import { claimEffects } from '../engine/claim-effects.ts';
import { createCommandLog } from '../engine/command-log.ts';
import {
  type Driver,
  type DriverNotice,
  openDriver,
  type RepositoryWorktrees,
  repositoryOf,
} from '../engine/driver.ts';
import type { DriverLock } from '../engine/driver-lock.ts';
import { combineEffects } from '../engine/effects.ts';
import type { EventStore } from '../engine/event-store.ts';
import type { Claimant, ClaimHost } from '../engine/issue-claims.ts';
import { keepOutDocs } from '../engine/kept-out-docs.ts';
import { type PullRequestRepository, pullRequestActions } from '../engine/pull-request-actions.ts';
import { STATE_BRANCH, type StateBranch } from '../engine/state-branch-git.ts';
import { statusEffects } from '../engine/status-comment.ts';
import { stepRunner } from '../engine/step-runner.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { githubClaimHost } from '../github/claims.ts';
import { createGitHubClient } from '../github/client.ts';
import { githubLogin } from '../github/login.ts';
import { githubIssueMarks } from '../github/marks.ts';
import { githubOrderText, githubOrderTitle } from '../github/order-text.ts';
import { githubPullRequests } from '../github/pull-requests.ts';
import { createGitHubReads, type GitHubReads } from '../github/reads.ts';
import { githubStatusComments } from '../github/status-comments.ts';
import { worktreeClonePath } from '../workspace/attempt-worktrees-git.ts';
import type { ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the wiring has opened so far, for the caller to close however far it got. */
export interface Opened {
  lock: DriverLock;
  store?: EventStore;
  driver?: Driver;
}

/** What a driver runs on once it is open. */
export interface Wired {
  store: EventStore;
  stateBranch: Pick<StateBranch, 'start' | 'flush'>;
  driver: Driver;
  /** One cache of conditional reads for every GitHub read (ADR 0052). */
  reads: GitHubReads;
  /** The claim refs, with the engine's own writes noted for the noPush guard (ADR 0106). */
  claims: ClaimHost;
  claimant: Claimant;
}

export interface WiringOptions {
  /** Whether the driver takes a free batch (ADR 0044). */
  takes: (batchId: string) => boolean;
  /** Prints one line of the driver's own, a notice or a report. */
  say: (line: string) => void;
  /** Reports a driver's notice. */
  report: (notice: DriverNotice) => void;
}

/**
 * Opens the store, the state branch and the driver under `opened.lock`, noting each in `opened`
 * as it goes: on a throw, the caller closes what is there with `closeOpened`.
 */
export const wireDriver = async (
  setup: ServeSetup,
  shell: ServeShell,
  opened: Opened,
  { takes, say, report }: WiringOptions,
): Promise<Wired> => {
  const { signal, clock } = shell;
  const { lock } = opened;
  const store = shell.openStore(setup.store);
  opened.store = store;
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
    // GitHub's rate-limit pause runs on the driver's clock, which also decides when to poll.
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
  let driver: Driver | undefined;
  const state = () => {
    if (driver === undefined) throw new Error('the driver is not open yet');
    return driver.state();
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
    // A stop: no git of the guard outlives the driver.
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
    takes,
    stateBranch,
    limits: plans.limits,
    outDoc: plans.outDoc,
    worktrees,
    // A check step runs no claude, so it has no session (ADR 0116).
    brews: (ref) => !isCheck(ref),
    alsoCleans: [attemptSettingsCleaner(setup.workRoot)],
    effects,
    actions,
    report,
  });
  opened.driver = driver;
  return { store, stateBranch, driver, reads, claims, claimant };
};

/** Closes what `opened` holds: the driver, which stops its runs and lets the lock go, or the lock. */
export const closeOpened = ({ lock, store, driver }: Opened): void => {
  if (driver === undefined) lock.release();
  else driver.close();
  store?.close();
};
