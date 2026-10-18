// The check runner (ADR 0069): runs the attempts of check steps, the gravity readings. For an attempt
// the driver started, it runs the step's checks one after another in the attempt's worktree through
// the platform shell and the process runner, which kills the whole tree at the step's deadline or
// when the engine stops the attempt; the first check that does not pass ends the step. No model.
// A red proof runs the test check and judges the structured test report against the tests the
// proven step committed, never the exit code (ADR 0078).

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type OutDocRead, readOutDocFile } from '../brewers/claude-runner.ts';
import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { buildBrewerEnv, type Env } from '../engine/brewer-env.ts';
import type { AttemptEnd, BrewerRunner } from '../engine/brewer-runner.ts';
import type { Batch, State } from '../engine/fold.ts';
import type { StepChecks } from '../engine/recipe-files.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { parseJunit } from '../formats/junit.ts';
import { parseTap } from '../formats/tap.ts';
import { envNameKey } from '../platform/env.ts';
import type { ExecProcess, ExecResult } from '../platform/processes.ts';
import type { TestReportConfig } from '../schemas/brewery-config.ts';
import type { GravityReading, WorktreeRef } from '../schemas/events.ts';
import type { Git } from '../workspace/git.ts';
import {
  type PlannedCheck,
  passed,
  planChecks,
  type RepositoryChecks,
  readingOf,
  settleReadings,
} from './gravity.ts';
import { judgeRed, needsTestReport } from './red-proof.ts';
import { readDiff, stepCommits } from './step-commits.ts';

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

/** A test report file's largest size: a report of a large suite, read once per red proof. */
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

/** The test report files of the real file system: removed when there, read as an out doc is. */
const fileReports: ReportFiles = {
  clear: (file) => rmSync(file, { force: true }),
  read: (file, root) => readOutDocFile(file, MAX_REPORT_BYTES, root),
};

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
  const { state, checks, exec, git, clock, platform = process.platform } = options;
  const reports = options.reports ?? fileReports;
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

  /** Runs one check in the worktree, killed before the attempt's deadline or at the stop. */
  const runCheck = (
    check: Extract<PlannedCheck, { kind: 'run' }>,
    worktree: WorktreeRef,
    deadlineAt: string,
    signal: AbortSignal,
  ): Promise<ExecResult> => {
    // The process runner kills the tree before the step's deadline, also when no tick comes:
    // early enough that the kill's grace ends and the reading is recorded before a tick expires
    // the attempt and loses it.
    const left = Date.parse(deadlineAt) - clock().getTime();
    const timeoutMs = Math.max(1, left - KILL_MARGIN_MS);
    return exec(check.command, [], {
      cwd: worktree.path,
      env,
      timeoutMs,
      signal,
      shell: true,
      jobObject: true,
    });
  };

  /**
   * A red proof (ADR 0078): the test check's reading, then the report it wrote, judged against
   * what step `of` committed.
   */
  const proveRed = async (
    batch: Batch,
    ref: AttemptRef,
    worktree: WorktreeRef,
    deadlineAt: string,
    of: string,
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    const recipe = batch.recipe?.name ?? '';
    const report = options.testReport(worktree.repo);
    if (report === undefined) return blocked('environment', needsTestReport(recipe, worktree.repo));
    const commits = stepCommits(batch, of);
    if (commits === undefined) {
      return blocked(
        'divergence',
        `step ${ref.stepId} proves the tests of step ${of}, which has no attempt that succeeded`,
      );
    }
    const diff = await readDiff(git, worktree.path, commits, signal);
    if ('error' in diff) {
      return blocked('environment', `the commits of step ${of} cannot be read: ${diff.error}`);
    }
    const [check] = planChecks(
      ['test'],
      options.repositoryChecks(worktree.repo) ?? NO_CHECKS,
      platform,
    );
    // foedrum.jsonc's schema gives every repository with a test report its test check.
    if (check?.kind !== 'run') {
      return blocked('environment', `foedrum.jsonc gives ${worktree.repo} no test check`);
    }
    // A report the tree holds, committed or left over, must not stand for this run's.
    const file =
      report.path === undefined ? undefined : join(worktree.path, ...report.path.split('/'));
    if (file !== undefined) reports.clear(file);
    const result = await runCheck(check, worktree, deadlineAt, signal);
    const reading = readingOf(check, result);
    const readings = [reading];
    // A check that did not exit read no report: it ends as any check does (ADR 0069).
    if (reading.result !== 'exited') return { ending: settleReadings(readings), readings };
    const failed = (why: string): AttemptEnd => ({
      ending: {
        kind: 'failed',
        retryable: false,
        reason: `the red proof of step ${of} failed: ${why}`,
      },
      readings,
    });
    let text = result.stdout;
    if (file !== undefined) {
      const read = reports.read(file, worktree.path);
      switch (read.kind) {
        case 'missing':
          return failed(`the test command wrote no test report at ${report.path}`);
        case 'unread':
          return failed(`the test report ${report.path} cannot be read: ${read.reason}`);
        case 'text':
          text = read.text;
          break;
        default: {
          const unhandled: never = read;
          throw new Error(`Unhandled read ${JSON.stringify(unhandled)}`);
        }
      }
    }
    const parsed = report.format === 'tap' ? parseTap(text) : parseJunit(text);
    if (!parsed.readable) {
      const where = report.path ?? 'on stdout';
      const format = report.format === 'tap' ? 'TAP' : 'JUnit XML';
      return failed(`the test report ${where} is not ${format}: ${parsed.reason}`);
    }
    const verdict = judgeRed(parsed.report, diff.files);
    if (!verdict.proven) return failed(verdict.why);
    return { ending: { kind: 'succeeded', output: null }, readings };
  };

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
    const refs = checks.find(recipe, stepId);
    if (refs === undefined)
      return blocked('divergence', `recipe ${recipe} has no check step ${stepId}`);
    const of = checks.proves(recipe, stepId);
    if (of !== undefined) return proveRed(batch, ref, worktree, current.deadlineAt, of, signal);
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
      const reading = readingOf(check, await runCheck(check, worktree, current.deadlineAt, signal));
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
