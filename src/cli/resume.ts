// `foedrum resume <batch> [<step>[#<n>]]` (ADR 0126): opens a finished brewer attempt's own Claude
// Code session in its worktree, with its settings file written again and the brewer's
// environment, while the attempt's lease claims it. resume-main.ts gives it the real machine; unit
// tests give fakes.

import { join } from 'node:path';
import { attemptPermissions, modelOf, settingsFileOf, toolsOf } from '../brewers/attempt-plan.ts';
import { attemptSettings } from '../brewers/attempt-settings.ts';
import { isSessionId, resumeArgs } from '../brewers/claude-command.ts';
import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { defaultLeaseMs } from '../engine/batch-leases.ts';
import { buildBrewerEnv } from '../engine/brewer-env.ts';
import type { EventStore, Lease, StoredEvent } from '../engine/event-store.ts';
import { fold, type State } from '../engine/fold.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { envNameKey } from '../platform/env.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { ResumeCommand } from '../schemas/commands.ts';
import type { SessionRef, WorktreeRef } from '../schemas/events.ts';
import type { AttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import type { CliResult } from './run.ts';
import type { ServeRepository, ServeSetup } from './serve-config.ts';

/** What resume needs of serve's setup: where the attempts ran and how their brewers are set up. */
export type ResumeSetup = Pick<
  ServeSetup,
  'workRoot' | 'repositories' | 'models' | 'brewers' | 'claude' | 'sandbox' | 'brewerEnv'
>;

/** What resume needs from the machine. */
export interface ResumeShell {
  /** The Brewery's root: the event store is `.foedrum/index.db` in it. */
  cwd: string;
  /** Opens the event store for writing its leases, or `undefined` when there is none. */
  openStore: (path: string) => EventStore | undefined;
  /** Serve's setup of the Brewery, or serve's problems. */
  setup: () => Promise<
    { kind: 'ready'; setup: ResumeSetup } | { kind: 'refused'; problems: string[] }
  >;
  /** The attempt worktrees of a repository under the work root. */
  worktrees: (
    repository: ServeRepository,
    workRoot: string,
  ) => Promise<Pick<AttemptWorktrees, 'recreate'>>;
  /** Whether Claude Code keeps the session `id` on this machine. */
  sessionFound: (id: string) => boolean;
  /** Writes an attempt's settings file, making its folder. */
  writeSettings: (file: string, settings: AttemptSettings) => void;
  /**
   * Whether this runs inside a Claude Code session (`CLAUDE_CODE_CHILD_SESSION=1`), which cannot
   * hand its terminal over, and whether stdin is a terminal.
   */
  terminal: { claudeCode: boolean; tty: boolean };
  /** This process's environment: only the terminal's own variables reach claude from it. */
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /**
   * Runs `program` in the foreground in `cwd` with the terminal's stdio and the environment `env`;
   * its exit code.
   */
  claude: (
    program: string,
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<number>;
  now: () => Date;
  /** Calls `beat` every `everyMs` until the returned function is called. */
  heartbeat: (everyMs: number, beat: () => void) => () => void;
  /** Writes a line to the terminal while claude runs (stderr). */
  say: (line: string) => void;
  /** This process's id, which names the lease's owner. */
  pid: number;
  /**
   * Takes a running batch over and continues the session of step `stepId` in it, as the batch's
   * driver until that attempt ended (ADR 0127); serve's setup and wiring, so the real machine's.
   */
  running: (request: { batchId: string; stepId: string }) => Promise<CliResult>;
}

/**
 * Claude Code's config directory (ADR 0116): `CLAUDE_CONFIG_DIR` when set, by any case on Windows,
 * else `.claude` in the home folder.
 */
export const claudeConfigDir = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  home: string,
): string => {
  const key = envNameKey(platform);
  const set = Object.entries(env).find(([name]) => key(name) === 'CLAUDE_CONFIG_DIR')?.[1];
  return set === undefined || set === '' ? join(home, '.claude') : set;
};

/** Whether a transcript `<id>.jsonl` is in any project folder of `projects/` under `config`. */
export const sessionFoundIn = (
  config: string,
  id: string,
  fs: { folders: (path: string) => readonly string[]; exists: (path: string) => boolean },
): boolean => {
  const projects = join(config, 'projects');
  return fs.folders(projects).some((folder) => fs.exists(join(projects, folder, `${id}.jsonl`)));
};

/** What a terminal program reads to draw itself: the only variables of this process claude gets. */
const TERMINAL_NAMES = [
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  // Windows Terminal's.
  'WT_SESSION',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
];

const terminalEnv = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Record<string, string> => {
  const key = envNameKey(platform);
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value !== undefined && TERMINAL_NAMES.includes(key(name)) ? [[name, value]] : [],
    ),
  );
};

/** The attempt resume opens: its session and the worktree it ran in. */
interface Target {
  ref: AttemptRef;
  session: SessionRef;
  worktree: WorktreeRef;
}

type Refused = { refused: string };

const labelOf = ({ stepId, attempt }: AttemptRef): string => `${stepId}#${attempt}`;

// The attempt `ref` when it finished with a session and a worktree, or why not.
const finishedTarget = (state: State, ref: AttemptRef): Target | Refused => {
  const attempt = state.batches.get(ref.batchId)?.steps.get(ref.stepId)?.attempts.get(ref.attempt);
  const named = `attempt ${labelOf(ref)} of batch ${ref.batchId}`;
  if (attempt === undefined) {
    return { refused: `batch ${ref.batchId} has no attempt ${labelOf(ref)}` };
  }
  if (attempt.phase !== 'finished') return { refused: `${named} has not finished` };
  const { session, worktree } = attempt;
  if (session === undefined || worktree === undefined) {
    return { refused: `${named} ran no brewer: it has no session` };
  }
  return { ref, session, worktree };
};

/** Why a batch that a driver brews now is refused: taking one over is #338. */
const runningRefusal = (state: State, batchId: string): string | undefined => {
  const lane = state.batches.get(batchId)?.lane.kind;
  return lane === 'ordered' || lane === 'brewing'
    ? `batch ${batchId} is ${lane}; resuming a running batch is not supported yet (#338)`
    : undefined;
};

/**
 * The attempt `foedrum resume` opens (ADR 0126): the one `step` names as `<step>#<n>`, else the
 * latest that started with a session and finished, in the order of the log, of the step or of
 * the batch. A running batch is refused: taking one over is #338.
 */
const targetOf = (
  events: readonly StoredEvent[],
  state: State,
  batchId: string,
  step: string | undefined,
): Target | Refused => {
  const batch = state.batches.get(batchId);
  if (batch === undefined) return { refused: `no batch ${batchId} in the event store` };
  const running = runningRefusal(state, batchId);
  if (running !== undefined) return { refused: running };
  const at = step?.lastIndexOf('#') ?? -1;
  const stepId = at < 0 ? step : step?.slice(0, at);
  const attempt = at < 0 ? undefined : step?.slice(at + 1);
  if (attempt !== undefined && !/^[1-9][0-9]*$/.test(attempt)) {
    return { refused: `${step} names no attempt: write <step>#<n> with a whole number n from 1` };
  }
  if (stepId !== undefined && !batch.steps.has(stepId)) {
    return { refused: `batch ${batchId} has no attempt of step ${stepId}` };
  }
  if (stepId !== undefined && attempt !== undefined) {
    return finishedTarget(state, { batchId, stepId, attempt: Number(attempt) });
  }
  const starts = events.flatMap(({ event }) =>
    event.type === 'step.started' &&
    event.batchId === batchId &&
    (stepId === undefined || event.stepId === stepId)
      ? [{ batchId, stepId: event.stepId, attempt: event.attempt }]
      : [],
  );
  for (const ref of starts.reverse()) {
    const target = finishedTarget(state, ref);
    if (!('refused' in target)) return target;
  }
  const of = stepId === undefined ? '' : ` of step ${stepId}`;
  return { refused: `batch ${batchId} has no finished attempt${of} that ran a brewer` };
};

const failed = (line: string): CliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `foedrum resume: ${line}\n`,
});

/** Runs `foedrum resume`: claude's exit code, or one line on why it opened nothing. */
export const runResume = async (input: ResumeCommand, shell: ResumeShell): Promise<CliResult> => {
  const path = join(shell.cwd, '.foedrum', 'index.db');
  const store = shell.openStore(path);
  if (store === undefined) return failed(`no event store at ${path}`);
  try {
    const events = store.eventsAfter(0);
    const state = fold(events.map(({ event }) => event));
    const target = targetOf(events, state, input.batch, input.step);
    if ('refused' in target) return failed(target.refused);
    const { ref, session, worktree } = target;
    const { batchId } = ref;
    const label = `${batchId} ${labelOf(ref)}`;
    // From the log, so checked before it names a file or reaches claude's command line.
    if (!isSessionId(session.id)) {
      const id = JSON.stringify(session.id);
      return failed(
        `attempt ${labelOf(ref)} of batch ${batchId} records the session id ${id}, which is no session id`,
      );
    }
    // A Claude Code session cannot hand its terminal to claude: the engineer runs it in one.
    if (shell.terminal.claudeCode) {
      const run = `run this in a terminal in ${shell.cwd}:\n  foedrum resume ${label}\n`;
      const why =
        'foedrum resume opens claude in a terminal, which a Claude Code session cannot hand over';
      return { exitCode: 0, stdout: `${why}; ${run}`, stderr: '' };
    }
    if (!shell.terminal.tty) {
      const where = 'on Windows, a console window, or winpty in mintty';
      return failed(
        `stdin is not a terminal, and claude needs one: run foedrum resume in a terminal (${where})`,
      );
    }
    if (!shell.sessionFound(session.id)) {
      const kept = 'Claude Code keeps a session where it ran, for 30 days by default';
      return failed(`the session ${session.id} of ${label} is not on this machine: ${kept}`);
    }
    const ready = await shell.setup();
    if (ready.kind === 'refused') {
      const stderr = ready.problems.map((problem) => `foedrum resume: ${problem}\n`).join('');
      return { exitCode: 1, stdout: '', stderr };
    }
    const { setup } = ready;
    const repository = setup.repositories.find(({ repo }) => sameRepo(repo, worktree.repo));
    if (repository === undefined) {
      return failed(`${worktree.repo} is no repository of this Brewery`);
    }
    const recipe = state.batches.get(batchId)?.recipe?.name ?? '';
    const found = setup.brewers.find(recipe, ref.stepId);
    if (found === undefined) return failed(`recipe ${recipe} has no step ${ref.stepId}`);

    // The attempt's lease alone: the cleanup keeps its worktree, also of an ended batch
    // (worktreeClaims), a driver starts no other attempt of its step meanwhile (ADR 0055), and a
    // second resume of the session is refused. The batch stays free for its driver.
    const owner = `resume-${shell.pid}`;
    const key = attemptKey.encode(ref);
    const named = `attempt ${labelOf(ref)} of batch ${batchId}`;
    // Takes or renews the lease, unless another owner's is alive: then that lease. The first
    // claim also refuses a batch that a driver took up since the log was read (serve's setup
    // takes seconds), in the transaction, so no attempt of the step starts in between.
    const claim = (first: boolean): Lease | string | undefined =>
      store.withTransaction((tx) => {
        const now = shell.now();
        if (first) {
          const latest = fold(store.eventsAfter(0).map(({ event }) => event));
          const running = runningRefusal(latest, batchId);
          if (running !== undefined) return running;
        }
        const other = store
          .currentLeases(now)
          .find((lease) => lease.attemptKey === key && lease.owner !== owner);
        if (other !== undefined) return other;
        tx.putLease({
          attemptKey: key,
          owner,
          expiresAt: new Date(now.getTime() + defaultLeaseMs),
        });
        return undefined;
      });
    const other = claim(true);
    if (typeof other === 'string') return failed(other);
    if (other !== undefined) {
      return failed(`${named} is open in ${other.owner} until ${other.expiresAt.toISOString()}`);
    }
    // A renewal never ends the session: what goes wrong is said on the terminal.
    const renew = (): void => {
      try {
        const taken = claim(false);
        if (typeof taken === 'object') {
          const ends = 'the cleanup may remove its worktree once that claim ends';
          shell.say(`foedrum resume: lost the claim on ${named} to ${taken.owner}: ${ends}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        shell.say(`foedrum resume: could not renew the claim on ${named}: ${message}`);
      }
    };
    const stop = shell.heartbeat(defaultLeaseMs / 3, renew);
    try {
      const { recreate } = await shell.worktrees(repository, setup.workRoot);
      const { path: folder } = await recreate(ref, worktree.commit);
      const permissions = attemptPermissions(found.brewer, repository.tools, setup.sandbox);
      const settingsFile = settingsFileOf(setup.workRoot, ref);
      shell.writeSettings(settingsFile, attemptSettings(permissions));
      const args = resumeArgs({
        model: modelOf(setup.models, found.brewer),
        effort: found.brewer.effort,
        settingsFile,
        tools: toolsOf(permissions.allow),
        sessionId: session.id,
      });
      // The attempt's environment (ADR 0109's forced variables included) with the terminal's own.
      const env = buildBrewerEnv({
        base: { ...setup.brewerEnv.base, ...terminalEnv(shell.env, shell.platform) },
        brewer: found.brewer.env,
        forced: setup.brewerEnv.forced,
        platform: shell.platform,
      });
      const exitCode = await shell.claude(setup.claude, args, folder, env);
      return { exitCode, stdout: '', stderr: '' };
    } finally {
      stop();
      // Never another owner's lease.
      store.withTransaction((tx) => {
        const leases = store.currentLeases(shell.now());
        if (!leases.some((lease) => lease.attemptKey === key && lease.owner !== owner)) {
          tx.releaseLease(key);
        }
      });
    }
  } finally {
    store.close();
  }
};
