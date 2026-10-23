// A repository's setup (ADR 0140, ADR 0158) and the command lines of check steps: how one line runs
// in a worktree through a process runner, killed before the attempt's deadline, in the brewers'
// environment without claude's login. The check runner runs the setup before a check step's checks,
// and the brewer runners before claude (ADR 0163).

import { buildBrewerEnv, type Env } from '../engine/brewer-env.ts';
import { checksRunUnsandboxed } from '../platform/check-sandbox.ts';
import { envNameKey } from '../platform/env.ts';
import type { ExecProcess, ExecResult } from '../platform/processes.ts';
import type { RepositorySetup } from '../schemas/brewery-config.ts';
import type { GravityReading } from '../schemas/events.ts';
import { durationMs } from '../schemas/primitives.ts';
import { commandLine, type PlannedCheck, readingOf } from './gravity.ts';

/**
 * How long before the attempt's deadline a command line is killed: the process runner's grace
 * between SIGTERM and SIGKILL (2.5 s) and a supervisor tick (5 s, ADR 0027), with room to spare.
 */
const KILL_MARGIN_MS = 10_000;

/**
 * claude's login and settings, which the brewers' base keeps for claude: a check, which has the
 * network on native Windows (ADR 0076), gets none of them (ADR 0069).
 */
const forClaude = (key: string): boolean =>
  key.startsWith('ANTHROPIC_') ||
  key === 'CLAUDE_CONFIG_DIR' ||
  key === 'CLAUDE_CODE_GIT_BASH_PATH';

/**
 * The environment of a check or a setup: nothing a brewer does not get, and not claude's login
 * either; by key, so a forced PATH replaces Path on Windows (ADR 0063, ADR 0069).
 */
export function checksEnv(env: { base: Env; forced: Env }, platform: NodeJS.Platform): Env {
  const key = envNameKey(platform);
  const base = Object.fromEntries(
    Object.entries(env.base).filter(([name]) => !forClaude(key(name))),
  );
  return buildBrewerEnv({ base, brewer: {}, forced: env.forced, platform });
}

/** Where and how long one command line runs. */
export interface LineRun {
  cwd: string;
  env: Env;
  /** The attempt's deadline: the line is killed `KILL_MARGIN_MS` before it. */
  deadlineAt: string;
  now: () => Date;
  signal: AbortSignal;
  /** Its own limit, when that is sooner than the deadline's. */
  timeoutMs?: number;
  maxOutputBytes?: number | undefined;
}

/**
 * Runs one command line through the platform shell, on Windows in a Job Object, killed before the
 * attempt's deadline, at `timeoutMs` when that is sooner, or at the stop.
 */
export function runLine(through: ExecProcess, command: string, run: LineRun): Promise<ExecResult> {
  const { cwd, env, deadlineAt, now, signal, timeoutMs = Infinity, maxOutputBytes } = run;
  // The process runner kills the tree before the step's deadline, also when no tick comes:
  // early enough that the kill's grace ends and the reading is recorded before a tick expires
  // the attempt and loses it.
  const left = Date.parse(deadlineAt) - now().getTime();
  return through(command, [], {
    cwd,
    env,
    timeoutMs: Math.max(1, Math.min(timeoutMs, left - KILL_MARGIN_MS)),
    signal,
    shell: true,
    jobObject: true,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  });
}

/** A repository's setup as it runs on a platform. */
export interface SetupRun {
  /** Its command line for the platform. */
  command: string;
  /** Its own timeout. */
  timeoutMs: number;
  /** Whether no sandbox holds it: on native Windows (ADR 0158). */
  unsandboxed: boolean;
}

/** The setup `found` as it runs on `platform`. */
export function setupRunOf(found: RepositorySetup, platform: NodeJS.Platform): SetupRun {
  return {
    command: commandLine(found.command, platform),
    timeoutMs: durationMs(found.timeout),
    unsandboxed: checksRunUnsandboxed(platform),
  };
}

/**
 * What one run of `check` read; when no sandbox held it, it says so: a check or a setup on native
 * Windows (ADR 0076, ADR 0158).
 */
export function readingOn(
  check: Extract<PlannedCheck, { kind: 'run' }>,
  result: ExecResult,
  unsandboxed: boolean,
): GravityReading {
  const reading = readingOf(check, result);
  return unsandboxed && reading.result !== 'skipped'
    ? { ...reading, unsandboxed: true as const }
    : reading;
}

/**
 * The reading of a repository's setup, run in the worktree with the network, in the check sandbox
 * where there is one (ADR 0158).
 */
export async function runSetup(
  through: ExecProcess,
  setup: SetupRun,
  run: Omit<LineRun, 'timeoutMs' | 'maxOutputBytes'>,
): Promise<GravityReading> {
  const check = { kind: 'run', setup: true, command: setup.command } as const;
  const result = await runLine(through, setup.command, { ...run, timeoutMs: setup.timeoutMs });
  return readingOn(check, result, setup.unsandboxed);
}
