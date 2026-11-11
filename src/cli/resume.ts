// `foedrum resume <issue> [<step>[#<n>]]` (ADR 0126): opens a finished brewer attempt's own Claude
// Code session in its worktree, with its settings file written again and the brewer's
// environment, while the attempt's lease claims it. resume-main.ts gives it the real machine; unit
// tests give fakes.

import { dirname, join } from 'node:path';
import {
  attemptPermissions,
  attemptSystemPrompt,
  modelOf,
  settingsFileOf,
  toolsOf,
} from '../brewers/attempt-plan.ts';
import { attemptSettings } from '../brewers/attempt-settings.ts';
import { isSessionId, resumeArgs } from '../brewers/claude-command.ts';
import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { defaultLeaseMs } from '../engine/batch-leases.ts';
import { buildBrewerEnv } from '../engine/brewer-env.ts';
import { calledAs, saidAs } from '../engine/claim-orders.ts';
import type { EventStore, Lease, StoredEvent } from '../engine/event-store.ts';
import {
  attemptRecipeOf,
  type Batch,
  fold,
  foldedBatch,
  latestAttempt,
  runningAttempt,
  type State,
} from '../engine/fold.ts';
import { resumeOf } from '../engine/session-resume.ts';
import { sessionCommand } from '../engine/status-comment.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { envNameKey } from '../platform/env.ts';
import { messageOf } from '../platform/errors.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { ResumeInput } from '../schemas/commands.ts';
import type { CheckoutRef, SessionRef, WorktreeRef } from '../schemas/events.ts';
import { checkoutName } from '../workspace/attempt-worktrees.ts';
import type { AttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import type { CliResult } from './run.ts';
import { type ServeRepository, type ServeSetup, storePath } from './serve-config.ts';

/** What resume needs of serve's setup: where the attempts ran and how their brewers are set up. */
export type ResumeSetup = Pick<
  ServeSetup,
  | 'workRoot'
  | 'repositories'
  | 'models'
  | 'brewers'
  | 'claude'
  | 'sandbox'
  | 'configDirs'
  | 'brewerEnv'
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
  ) => Promise<Pick<AttemptWorktrees, 'recreate' | 'checkout'>>;
  /** Whether Claude Code keeps the session `id` on this machine. */
  sessionFound: (id: string) => boolean;
  /** Writes an attempt's settings file, making its folder. */
  writeSettings: (file: string, settings: AttemptSettings) => void;
  /** Writes an attempt's system prompt file beside its settings file (ADR 0183). */
  writeSystemPrompt: (file: string, text: string) => void;
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

export const terminalEnv = (
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

/**
 * The attempt resume opens: its session and the worktree it ran in, or a Brewery order's checkouts
 * of every repository (ADR 0301).
 */
type Target = { ref: AttemptRef; session: SessionRef } & (
  | { worktree: WorktreeRef }
  | { checkouts: readonly CheckoutRef[] }
);

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
  const { session, worktree, checkouts } = attempt;
  if (session !== undefined && checkouts !== undefined) return { ref, session, checkouts };
  if (session === undefined || worktree === undefined) {
    return { refused: `${named} ran no brewer: it has no session` };
  }
  return { ref, session, worktree };
};

/**
 * Where a resumed session runs again: its worktree, recreated at its commit, or a Brewery order's
 * folder, each checkout made again at its commit (ADR 0301).
 */
const placeOf = async (
  ref: AttemptRef,
  places: readonly { repository: ServeRepository; commit: string }[],
  inWorktree: boolean,
  worktrees: (
    repository: ServeRepository,
  ) => Promise<Pick<AttemptWorktrees, 'recreate' | 'checkout'>>,
): Promise<string> => {
  const paths: string[] = [];
  for (const { repository, commit } of places) {
    const manager = await worktrees(repository);
    if (inWorktree) return (await manager.recreate(ref, commit)).path;
    const name = checkoutName(repository.repo, repository.alias);
    paths.push((await manager.checkout(ref, name, { kind: 'resume', commit })).path);
  }
  const [first] = paths;
  if (first === undefined) throw new Error(`attempt ${labelOf(ref)} names no repository`);
  return dirname(first);
};

/** The step of a running batch whose session resume continues as the batch's driver (ADR 0127). */
interface Running {
  running: true;
  /** The attempt whose session it continues: the one that runs, or the one before a retry. */
  ref: AttemptRef;
  session: string;
}

/** An interactive step's attempt whose session is open in a person's terminal (ADR 0231). */
interface Open {
  open: true;
  ref: AttemptRef;
  /** When its session opened (`interactiveSince`). */
  since: string;
}

/** Whether a driver brews `batchId` now: resume then takes it over (ADR 0127). */
const isRunning = (state: State, batchId: string): boolean => {
  const lane = state.batches.get(batchId)?.lane.kind;
  return lane === 'ordered' || lane === 'brewing';
};

/**
 * The step of the running `batch` whose session resume continues (ADR 0127): of `stepId`, or the
 * first step of the batch that has one, whose latest attempt runs a brewer's session, or waits
 * to resume the session of the attempt before it (a retry or an answer, `resumeOf`). An interactive
 * step whose session is open, of `stepId` or of any step, is refused instead (ADR 0231).
 */
const runningTarget = (
  state: State,
  batch: Batch,
  stepId: string | undefined,
  attempt: string | undefined,
): Running | Open | Refused => {
  const batchId = batch.id;
  const said = saidAs(state, batch);
  if (batch.lane.kind === 'ordered') {
    return { refused: `${said} is ordered: no step of it has run yet` };
  }
  if (attempt !== undefined) {
    const latest = 'name the step alone, and foedrum resume continues its latest attempt';
    return { refused: `${said} is ${batch.lane.kind}: ${latest}` };
  }
  const steps = stepId === undefined ? [...batch.steps.values()] : [batch.steps.get(stepId)];
  // A person's session cannot be stopped from outside, so it is never taken over (ADR 0231), also
  // when no step is named and a headless step before it runs.
  for (const step of steps) {
    if (step === undefined) continue;
    const latest = runningAttempt(step);
    if (latest?.phase !== 'started') continue;
    const { attempt: n, interactiveSince: since } = latest;
    if (since !== undefined)
      return { open: true, ref: { batchId, stepId: step.id, attempt: n }, since };
  }
  let why: string | undefined;
  for (const step of steps) {
    if (step === undefined) continue;
    const latest = latestAttempt(step);
    if (latest === undefined || (latest.phase !== 'finished' && latest.abandoned === true)) {
      continue;
    }
    const ref = { batchId, stepId: step.id, attempt: latest.attempt };
    if (latest.phase === 'started' && latest.session !== undefined) {
      return { running: true, ref, session: latest.session.id };
    }
    if (latest.phase !== 'scheduled') continue;
    const resumption = resumeOf(batch, ref);
    if (resumption?.kind === 'resume') {
      return { running: true, ref: resumption.from, session: resumption.session };
    }
    const fresh = resumption?.why ?? 'it is no retry or answer';
    why ??= `${labelOf(ref)} of batch ${batchId} would start a fresh session: ${fresh}`;
  }
  const none = 'no attempt running or waiting to continue a session';
  const of = stepId === undefined ? `batch ${batchId}` : `step ${stepId} of batch ${batchId}`;
  return { refused: why ?? `${of} has ${none}` };
};

/**
 * The attempt `foedrum resume` opens (ADR 0126): the one `step` names as `<step>#<n>`, else the
 * latest that started with a session and finished, in the order of the log, of the step or of
 * the batch. On a running batch, the step whose session it continues as its driver (ADR 0127).
 */
const targetOf = (
  events: readonly StoredEvent[],
  state: State,
  batchId: string,
  step: string | undefined,
): Target | Running | Open | Refused => {
  const batch = state.batches.get(batchId);
  if (batch === undefined && state.archived.has(batchId)) {
    return {
      refused: `batch ${batchId} is archived: it ended, and a cleanup moved it to archive/ on the state branch`,
    };
  }
  if (batch === undefined) return { refused: `no batch ${batchId} in the event store` };
  const at = step?.lastIndexOf('#') ?? -1;
  const stepId = at < 0 ? step : step?.slice(0, at);
  const attempt = at < 0 ? undefined : step?.slice(at + 1);
  if (attempt !== undefined && !/^[1-9][0-9]*$/.test(attempt)) {
    return { refused: `${step} names no attempt: write <step>#<n> with a whole number n from 1` };
  }
  if (stepId !== undefined && !batch.steps.has(stepId)) {
    return { refused: `batch ${batchId} has no attempt of step ${stepId}` };
  }
  if (isRunning(state, batchId)) return runningTarget(state, batch, stepId, attempt);
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

/**
 * Why an open interactive session is refused (ADR 0231): it must close so it reports, and brew
 * opens it again when it closed without its out doc. Open for sure only while its attempt's lease
 * lives, which brew renews while it waits on claude; the batch's may be another driver's.
 */
const openLine = ({ ref, since }: Open, leases: readonly Lease[], called: string): string => {
  const of = `${labelOf(ref)} of batch ${ref.batchId} is an interactive session`;
  const brew = sessionCommand(called);
  const key = attemptKey.encode(ref);
  const lease = leases.find((held) => held.attemptKey === key);
  if (lease === undefined) {
    const lapses = "it waits for a session again once the attempt's lease lapses";
    return `${of} open since ${since}, and no driver holds the session: ${lapses}, then ${brew} opens a fresh one`;
  }
  const until = lease.expiresAt.toISOString();
  const close = `close it there so it reports; if it closes without its out doc, ${brew} opens it again`;
  return `${of} still open in ${lease.owner} (since ${since}, lease until ${until}): ${close}`;
};

/** Runs `foedrum resume`: claude's exit code, or one line on why it opened nothing. */
export const runResume = async (input: ResumeInput, shell: ResumeShell): Promise<CliResult> => {
  const path = storePath(shell.cwd);
  const store = shell.openStore(path);
  if (store === undefined) return failed(`no event store at ${path}`);
  try {
    const events = store.eventsAfter(0);
    const state = fold(events.map(({ event }) => event));
    const target = targetOf(events, state, input.batch, input.step);
    if ('refused' in target) return failed(target.refused);
    if ('open' in target) {
      const called = calledAs(state, foldedBatch(state, target.ref.batchId));
      return failed(openLine(target, store.currentLeases(shell.now()), called));
    }
    const { ref } = target;
    const session = 'running' in target ? target.session : target.session.id;
    const { batchId } = ref;
    const label = `${batchId} ${labelOf(ref)}`;
    // From the log, so checked before it names a file or reaches claude's command line.
    if (!isSessionId(session)) {
      const id = JSON.stringify(session);
      return failed(
        `attempt ${labelOf(ref)} of batch ${batchId} records the session id ${id}, which is no session id`,
      );
    }
    // A Claude Code session cannot hand its terminal to claude: the engineer runs it in one.
    if (shell.terminal.claudeCode) {
      // A running batch's step alone: its latest attempt changes as the batch goes on.
      const called = calledAs(state, foldedBatch(state, batchId));
      const line = `${called} ${'running' in target ? ref.stepId : labelOf(ref)}`;
      const run = `run this in a terminal in ${shell.cwd}:\n  foedrum resume ${line}\n`;
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
    if (!shell.sessionFound(session)) {
      const kept = 'Claude Code keeps a session where it ran, for 30 days by default';
      return failed(`the session ${session} of ${label} is not on this machine: ${kept}`);
    }
    if ('running' in target) return await shell.running({ batchId, stepId: ref.stepId });
    const ready = await shell.setup();
    if (ready.kind === 'refused') {
      const stderr = ready.problems.map((problem) => `foedrum resume: ${problem}\n`).join('');
      return { exitCode: 1, stdout: '', stderr };
    }
    const { setup } = ready;
    // Its worktree's repository, or every repository a Brewery order's checkouts hold (ADR 0301).
    const recorded = 'worktree' in target ? [target.worktree] : target.checkouts;
    const places: { repository: ServeRepository; commit: string }[] = [];
    for (const { repo, commit } of recorded) {
      const repository = setup.repositories.find((each) => sameRepo(each.repo, repo));
      if (repository === undefined) return failed(`${repo} is no repository of this Brewery`);
      places.push({ repository, commit });
    }
    // The recipe the attempt ran under, which the batch may have left since (ADR 0265).
    const recipe = attemptRecipeOf(state, ref) ?? '';
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
          if (isRunning(latest, batchId)) {
            const { kind } = latest.batches.get(batchId)?.lane ?? {};
            return `${saidAs(latest, foldedBatch(latest, batchId))} is ${kind} now: run foedrum resume again to take it over`;
          }
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
        const message = messageOf(error);
        shell.say(`foedrum resume: could not renew the claim on ${named}: ${message}`);
      }
    };
    const stop = shell.heartbeat(defaultLeaseMs / 3, renew);
    try {
      const folder = await placeOf(ref, places, 'worktree' in target, (repository) =>
        shell.worktrees(repository, setup.workRoot),
      );
      // A Brewery order's folder is no repository's, so it gets no repository's tools.
      const [own] = places;
      const permissions = attemptPermissions(
        found.brewer,
        'worktree' in target && own !== undefined ? own.repository.tools : [],
        setup.sandbox,
        setup.configDirs,
        setup.brewerEnv.base,
      );
      const settingsFile = settingsFileOf(setup.workRoot, ref);
      shell.writeSettings(settingsFile, attemptSettings(permissions));
      const systemPrompt = attemptSystemPrompt(found.brewer, permissions.allow, settingsFile);
      shell.writeSystemPrompt(systemPrompt.file, systemPrompt.text);
      const args = resumeArgs({
        model: modelOf(setup.models, found.brewer),
        effort: found.brewer.effort,
        settingsFile,
        tools: toolsOf(permissions.allow),
        sessionId: session,
        appendSystemPromptFile: systemPrompt.file,
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
