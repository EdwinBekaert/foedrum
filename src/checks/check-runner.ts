// The check runner (ADR 0069): runs the attempts of check steps, the gravity readings. For an attempt
// the driver started, it runs the step's checks one after another in the attempt's worktree through
// the platform shell and the process runner, which kills the whole tree at the step's deadline or
// when the engine stops the attempt; the first check that does not pass ends the step. No model.

import type { OutDocRead } from '../brewers/claude-runner.ts';
import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { buildBrewerEnv, type Env } from '../engine/brewer-env.ts';
import type { AttemptEnd, BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { StepChecks } from '../engine/recipe-files.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { envNameKey } from '../platform/env.ts';
import type { ExecProcess } from '../platform/processes.ts';
import type { TestReportConfig } from '../schemas/brewery-config.ts';
import type { GravityReading } from '../schemas/events.ts';
import type { Git } from '../workspace/git.ts';
import { passed, planChecks, type RepositoryChecks, readingOf, settleReadings } from './gravity.ts';

/** A test report's file in a worktree: cleared before the test check runs, read after it. */
export interface ReportFiles {
  clear: (file: string) => void;
  /** Reads the report only inside `root`, the worktree. */
  read: (file: string, root: string) => OutDocRead;
}

export interface CheckRunnerOptions {
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** The checks of the recipes' check steps (`loadRecipes`). */
  checks: StepChecks;
  /** The commands of a repository's checks (`foedrum.jsonc`), or undefined when it lists none. */
  repositoryChecks: (repo: string) => RepositoryChecks | undefined;
  /** The test report a repository's test check writes (`foedrum.jsonc`), for red proofs. */
  testReport: (repo: string) => TestReportConfig | undefined;
  exec: ExecProcess;
  /** git, for the commits of the step a red proof proves (ADR 0078). */
  git: Git;
  /** Default the file system's. */
  reports?: ReportFiles;
  /** The brewers' environment: its minimal base and the runner's forced variables (ADR 0063). */
  env: { base: Env; forced: Env };
  clock: () => Date;
  /** Default this process's. */
  platform?: NodeJS.Platform;
}

/**
 * How long before the attempt's deadline a check is killed: the process runner's grace between
 * SIGTERM and SIGKILL (2.5 s) and a supervisor tick (5 s, ADR 0027), with room to spare.
 */
const KILL_MARGIN_MS = 10_000;

/**
 * claude's login and settings, which the brewers' base keeps for claude: a check, which has the
 * network outside the sandbox, gets none of them (ADR 0069).
 */
const forClaude = (key: string): boolean =>
  key.startsWith('ANTHROPIC_') ||
  key === 'CLAUDE_CONFIG_DIR' ||
  key === 'CLAUDE_CODE_GIT_BASH_PATH';

// None of a repository's checks: what a step of literal commands plans against.
const NO_CHECKS: RepositoryChecks = {
  build: null,
  typecheck: null,
  lint: null,
  format: null,
  test: null,
};

export function createCheckRunner(options: CheckRunnerOptions): BrewerRunner {
  const { state, checks, exec, clock, platform = process.platform } = options;
  // Nothing a brewer does not get, and not claude's login either: by key, so a forced PATH
  // replaces Path on Windows (ADR 0063, ADR 0069).
  const key = envNameKey(platform);
  const base = Object.fromEntries(
    Object.entries(options.env.base).filter(([name]) => !forClaude(key(name))),
  );
  const env = buildBrewerEnv({ base, brewer: {}, forced: options.env.forced, platform });
  // The attempts it runs, by key, with when they started: their progress for the heartbeat.
  const running = new Map<string, AttemptProgress>();

  const blocked = (blockerKind: 'environment' | 'divergence', summary: string): AttemptEnd => ({
    ending: { kind: 'blocked', blockerKind, summary },
  });

  const run = async (ref: AttemptRef, signal: AbortSignal): Promise<AttemptEnd> => {
    const { batchId, stepId, attempt } = ref;
    const batch = state().batches.get(batchId);
    const current = batch?.steps.get(stepId)?.attempts.get(attempt);
    const worktree = current?.phase === 'started' ? current.worktree : undefined;
    if (batch === undefined || current === undefined || worktree === undefined) {
      return blocked(
        'environment',
        `attempt ${stepId}#${attempt} of batch ${batchId} has no worktree to read`,
      );
    }
    const recipe = batch.recipe?.name ?? '';
    if (checks.proves(recipe, stepId) !== undefined) throw new Error('not implemented');
    const refs = checks.find(recipe, stepId);
    if (refs === undefined)
      return blocked('divergence', `recipe ${recipe} has no check step ${stepId}`);
    let repository = NO_CHECKS;
    const named = refs.find((check) => typeof check === 'string');
    if (named !== undefined) {
      const found = options.repositoryChecks(worktree.repo);
      if (found === undefined) {
        return blocked(
          'environment',
          `foedrum.jsonc lists no checks of ${worktree.repo} for the check "${named}"`,
        );
      }
      repository = found;
    }
    const readings: GravityReading[] = [];
    for (const check of planChecks(refs, repository, platform)) {
      if (check.kind === 'skip') {
        readings.push({ result: 'skipped', check: check.check });
        continue;
      }
      // The process runner kills the tree before the step's deadline, also when no tick comes:
      // early enough that the kill's grace ends and the reading is recorded before a tick expires
      // the attempt and loses it.
      const left = Date.parse(current.deadlineAt) - clock().getTime();
      const timeoutMs = Math.max(1, left - KILL_MARGIN_MS);
      const result = await exec(check.command, [], {
        cwd: worktree.path,
        env,
        timeoutMs,
        signal,
        shell: true,
        jobObject: true,
      });
      const reading = readingOf(check, result);
      readings.push(reading);
      if (!passed(reading)) break;
    }
    return { ending: settleReadings(readings), readings };
  };

  return {
    start: ({ ref }) => {
      const key = attemptKey.encode(ref);
      const stop = new AbortController();
      running.set(key, { lastProgressAt: clock(), turnsWithoutProgress: 0 });
      const ended = run(ref, stop.signal).finally(() => running.delete(key));
      return { ended, stop: () => stop.abort() };
    },
    progress: (ref) => running.get(attemptKey.encode(ref)),
  };
}
