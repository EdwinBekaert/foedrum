// The wiring a driver on the real machine runs on (ADR 0063, ADR 0123), shared by `foedrum serve`
// and `foedrum brew`: under a lock the caller took, it opens the event store and the state branch,
// each repository's attempt worktrees, GitHub through gh, the status comments (ADR 0072) and the
// claim effects, the attempt plans, the check runner and the guards, and the driver with the real
// runner. Each caller says which batches its driver takes.

import { familyOfBrewer } from '../brewers/attempt-plan.ts';
import { createAttemptPlans } from '../brewers/attempt-plans.ts';
import { attemptSettingsCleaner } from '../brewers/attempt-settings-cleanup.ts';
import { type CheckTree, createCheckRunner } from '../checks/check-runner.ts';
import { needsTestReport } from '../checks/red-proof.ts';
import { guardTests } from '../checks/tests-guard.ts';
import type { AttemptRef } from '../engine/attempt-key.ts';
import { baseConflictEffects } from '../engine/base-check.ts';
import type { BrewerRunner, RunningAttempt } from '../engine/brewer-runner.ts';
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
import { laneLabelEffects } from '../engine/lane-labels.ts';
import { mergeBriefEffects } from '../engine/merge-brief-post.ts';
import { planEffects } from '../engine/plan-comment.ts';
import { type PullRequestRepository, pullRequestActions } from '../engine/pull-request-actions.ts';
import { recipeLabelEffects } from '../engine/recipe-label.ts';
import { statusEffects } from '../engine/status-comment.ts';
import { stepRunner } from '../engine/step-runner.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { githubClaimHost } from '../github/claims.ts';
import { createGitHubClient, type GitHubClient } from '../github/client.ts';
import { githubLogin } from '../github/login.ts';
import { githubIssueMarks } from '../github/marks.ts';
import { githubOrderText, githubOrderTitle } from '../github/order-text.ts';
import { githubPullRequests } from '../github/pull-requests.ts';
import { createGitHubReads, type GitHubReads } from '../github/reads.ts';
import { githubStatusComments } from '../github/status-comments.ts';
import type { AwakeHold } from '../platform/keep-awake.ts';
import { worktreeClonePath } from '../workspace/attempt-worktrees-git.ts';
import type { ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The runner that tells `awake` of each attempt it starts and when that attempt ends (ADR 0195). */
const heldAwake = (runner: BrewerRunner, awake: AwakeHold): BrewerRunner => ({
  start: (attempt) => {
    // Before the runner starts it: a check step's process starts inside `start`.
    awake.attemptStarted();
    const ended = () => awake.attemptEnded();
    let run: RunningAttempt;
    try {
      run = runner.start(attempt);
    } catch (error) {
      ended();
      throw error;
    }
    run.ended.then(ended, ended);
    return run;
  },
  progress: (ref) => runner.progress(ref),
});

/** What the wiring has opened so far, for the caller to close however far it got. */
export interface Opened {
  lock: DriverLock;
  store?: EventStore;
  driver?: Driver;
}

/** What a driver runs on once it is open. */
export interface Wired {
  store: EventStore;
  driver: Driver;
  /** One cache of conditional reads for every GitHub read (ADR 0052). */
  reads: GitHubReads;
  /** The GitHub client under them, for GraphQL (ADR 0073). */
  client: GitHubClient;
  /** The claim refs on GitHub (ADR 0043). */
  claims: ClaimHost;
  claimant: Claimant;
  /** Each repository's base and pushes, as the openPullRequest action has them (ADR 0071). */
  pushes: readonly PullRequestRepository[];
  /** The checks of a tree as the check runner reads a check step's (ADR 0203). */
  checkTree: CheckTree;
}

export interface WiringOptions {
  /** Whether the driver takes a free batch (ADR 0044). */
  takes: (batchId: string) => boolean;
  /** Which batches its owner held at its start it drives on; every one by default (ADR 0123). */
  drivesOn?: (batchId: string) => boolean;
  /**
   * Whether an attempt's retry or answer resumes its session: by default when its brewer's
   * `retryMode` is `resume` (ADR 0118); `foedrum resume` of a running batch, always (ADR 0127).
   */
  resumes?: (attempt: AttemptRef) => boolean;
  /** Whether the driver goes on with a batch it may hold; every one by default (ADR 0127). */
  holds?: (batchId: string) => boolean;
  /** Whether it opens an interactive step's session: `foedrum brew` on a terminal (ADR 0222). */
  sessions?: boolean;
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
  { takes, drivesOn, resumes, holds, sessions, say, report }: WiringOptions,
): Promise<Wired> => {
  const { signal, clock } = shell;
  const { lock } = opened;
  const store = shell.openStore(setup.store);
  opened.store = store;
  // Rebuilds or catches up the store from the branch (ADR 0011, ADR 0024).
  const stateBranch = shell.stateBranch(store);
  await stateBranch.start();
  const worktrees: RepositoryWorktrees[] = [];
  // Each repository's fetch, by its worktree manager: a plan's base it has no ref of (ADR 0233).
  const fetches = new Map<string, () => Promise<void>>();
  const pushes: PullRequestRepository[] = [];
  for (const repository of setup.repositories) {
    const { repo, base } = repository;
    const manager = await shell.worktrees(repository);
    fetches.set(repo.toLowerCase(), () => manager.fetch());
    // The pull request goes into the branch the attempts start from (ADR 0071).
    const into = base.slice(base.indexOf('/') + 1);
    const push = shell.push(repository);
    // The last check before the pull request merges that branch as the push fetches it (ADR 0164).
    const merge = { base: into, push, worktree: shell.merge(repository) };
    worktrees.push({ repo, base, manager, merge });
    const { sensitivePaths } = repository;
    pushes.push({
      repo,
      base: into,
      push,
      ...(sensitivePaths === undefined ? {} : { sensitivePaths }),
    });
  }
  const client = createGitHubClient({
    exec: shell.gh,
    hostname: setup.github.hostname,
    // GitHub's rate-limit pause runs on the driver's clock, which also decides when to poll.
    now: () => clock().getTime(),
  });
  // One cache of conditional reads for the intake, the marks and the orders' text (ADR 0052).
  const reads = createGitHubReads(client);
  const claims = githubClaimHost(client);
  // gh's login: the status comments and the claim marks count only its own (ADR 0072, ADR 0073).
  const login = await githubLogin(client, signal);
  const claimant: Claimant = { brewery: setup.brewery, login };
  const comments = githubStatusComments({ client, reads, login });
  const status = statusEffects({ brewery: setup.brewery, comments, recipes: setup.recipes, clock });
  // Each order's plan, one comment on its issue edited in place (ADR 0233).
  const planComments = planEffects({ brewery: setup.brewery, comments });
  const marks = githubIssueMarks({ client, reads, login });
  // Each Brewery issue's lane label, through the ledger as its status comment (ADR 0154).
  const labels = laneLabelEffects({ brewery: setup.brewery, host: marks });
  // The recipe an answer to the Innkeeper chose, as a label on the issue, once (ADR 0232).
  const recipeLabels = recipeLabelEffects({ brewery: setup.brewery, host: marks });
  // A claimed batch the store has keeps its marks and release due, intake or not (ADR 0050).
  const claimed = [
    ...createCommandLog({ store, recipes: setup.recipes }).state().batches.values(),
  ].some((batch) => batch.repo !== undefined);
  // A conflict with a base that moved, posted on its pull request (ADR 0198), and a failing check
  // on its merged tree, which says when the recipe sends the batch back to fix it (ADR 0226).
  const conflicts = baseConflictEffects({ marks, recipes: setup.recipes });
  // A ready pull request's merge brief, on it, its title read as an issue's (ADR 0225).
  const briefs = mergeBriefEffects({
    host: {
      find: comments.find,
      create: comments.create,
      title: marks.title,
      hidden: comments.hidden,
      hide: comments.hide,
    },
    recipes: setup.recipes,
    redProof: (recipe) => setup.checks.redProof(recipe)?.id,
  });
  const effects =
    setup.intake.repositories.length > 0 || claimed
      ? combineEffects(
          status,
          planComments,
          labels,
          recipeLabels,
          conflicts,
          briefs,
          claimEffects({ claimant, marks, claims }),
        )
      : combineEffects(status, planComments, labels, recipeLabels, conflicts, briefs);
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
    // Every attempt of a brewer with a shell gets its repository's dependencies first (ADR 0163).
    repoSetup: (repo) => repositoryNamed(repo)?.setup,
    // Where a commit-producing attempt's commits are counted (ADR 0074).
    clone,
    // A plan's paths are checked in each repository once it is done (ADR 0233).
    repositories: setup.repositories,
    // A base its clone has no ref of yet is fetched once, by its worktree manager (ADR 0233).
    fetchBase: async (repo) => {
      const fetch = fetches.get(repo.toLowerCase());
      if (fetch === undefined) throw new Error(`${repo} is no repository of this Brewery`);
      await fetch();
    },
    sandbox: setup.sandbox,
    ...(setup.configDirs === undefined ? {} : { configDirs: setup.configDirs }),
    workRoot: setup.workRoot,
    env: setup.brewerEnv,
    orderText: githubOrderText(reads, setup.brewery),
    // A Taster's change is read by the engine, so the Taster runs no git (ADR 0161).
    git: shell.git,
    // A brewer that asks for house yeast gets the rules that match its change (ADR 0169).
    houseYeast: {
      files: setup.houseYeast ?? [],
      keptIn: (repo) => repositoryNamed(repo)?.houseYeast ?? 'repo',
    },
  });
  // A check step's commands run in the brewers' environment, without a token variable (ADR 0069);
  // as the same OS user they can still start gh, which answers from its login (ADR 0073, #204).
  const checks = createCheckRunner({
    state,
    checks: setup.checks,
    repositoryChecks: (repo) => repositoryNamed(repo)?.checks,
    testReport: (repo) => repositoryNamed(repo)?.testReport,
    exec: shell.exec,
    // A repository's setup installs before the checks, with the network (ADR 0140).
    setup: { of: (repo) => repositoryNamed(repo)?.setup, exec: shell.setup },
    git: shell.git,
    clone,
    env: setup.brewerEnv,
    clock,
  });
  const recipeOf = (batchId: string) => state().batches.get(batchId)?.recipe?.name;
  const brewerOf = (batchId: string, stepId: string) =>
    setup.brewers.find(recipeOf(batchId) ?? '', stepId)?.brewer;
  const guardsOf = (batchId: string, stepId: string) => brewerOf(batchId, stepId)?.guards ?? [];
  // The brewer of a step with the testsUnchanged guard keeps the red proof's tests (ADR 0078).
  const brewer = guardTests({
    runner: shell.runner(setup.claude, plans.plan),
    state,
    protects: ({ batchId, stepId }) =>
      guardsOf(batchId, stepId).includes('testsUnchanged')
        ? setup.checks.redProof(recipeOf(batchId) ?? '')?.of
        : undefined,
    git: shell.git,
    clone,
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
      runner: shell.awake === undefined ? runner : heldAwake(runner, shell.awake),
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
    ...(drivesOn === undefined ? {} : { drivesOn }),
    ...(holds === undefined ? {} : { holds }),
    ...(sessions === undefined ? {} : { sessions }),
    stateBranch,
    limits: plans.limits,
    outDoc: plans.outDoc,
    worktrees,
    // A check step runs no claude, so it has no session (ADR 0116).
    brews: (ref) => !isCheck(ref),
    // The family of the model the brewer runs on, a blind-tasting swap included, says which
    // closed usage window holds it (ADR 0215).
    family: ({ batchId, stepId }) => {
      const stepBrewer = brewerOf(batchId, stepId);
      return stepBrewer && familyOfBrewer(setup.models, stepBrewer);
    },
    // A retry or an answer continues the session of a brewer that resumes (ADR 0117, ADR 0118),
    // but an interactive step's: its session opens anew, with the whole prompt (ADR 0222).
    resumes:
      resumes ??
      (({ batchId, stepId }) => {
        const stepBrewer = setup.brewers.find(recipeOf(batchId) ?? '', stepId);
        return stepBrewer?.interactive === undefined && stepBrewer?.brewer.retryMode === 'resume';
      }),
    alsoCleans: [attemptSettingsCleaner(setup.workRoot)],
    effects,
    actions,
    report,
  });
  opened.driver = driver;
  return { store, driver, reads, client, claims, claimant, pushes, checkTree: checks.checkTree };
};

/** Closes what `opened` holds: the driver, which stops its runs and lets the lock go, or the lock. */
export const closeOpened = ({ lock, store, driver }: Opened): void => {
  if (driver === undefined) lock.release();
  else driver.close();
  store?.close();
};
