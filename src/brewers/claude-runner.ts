// The real brewer runner (ADR 0003, ADR 0028, ADR 0047): runs an attempt as one `claude` process
// with the runner's own settings file, its prompt on stdin, inside a Job Object on Windows, and
// reads its stream line by line. What it saw goes through settleAttempt, as with the fake.

import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { passed, settleReadings } from '../checks/gravity.ts';
import { runSetup, type SetupRun } from '../checks/setup.ts';
import { attemptKey } from '../engine/attempt-key.ts';
import type { Env } from '../engine/brewer-env.ts';
import {
  type AttemptEnd,
  type AttemptFacts,
  type AttemptStart,
  type BrewerRunner,
  type CommitsSeen,
  type ProcessExit,
  settleAttempt,
} from '../engine/brewer-runner.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { pathInside } from '../platform/paths.ts';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  type ExecProcess,
  type StreamProcess,
  type StreamResult,
  streamProcess,
  type Timers,
} from '../platform/processes.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { GravityReading } from '../schemas/events.ts';
import type { HouseYeastSelection } from '../schemas/house-yeast.ts';
import { type CountCommits, countCommits } from '../workspace/attempt-commits-git.ts';
import { runGit } from '../workspace/git.ts';
import {
  type AttemptPermissions,
  attemptSettings,
  writeAttemptSettings,
} from './attempt-settings.ts';
import { type ClaudeCall, claudeArgs } from './claude-command.ts';
import { cut, readClaudeStream, type StreamFacts, type StreamReader } from './claude-stream.ts';
import type { BrewerPrompt } from './prompt.ts';

/** Everything one attempt needs, prepared by the engine (its worktree, prompt and session). */
export interface ClaudeAttemptPlan {
  /** The attempt's worktree; the out doc's path is relative to it. */
  cwd: string;
  /** The brewer's environment (buildBrewerEnv, ADR 0028). */
  env: NodeJS.ProcessEnv;
  /** Only a prompt from assembleBrewerPrompt (ADR 0041); it goes on stdin. */
  prompt: BrewerPrompt;
  call: Omit<ClaudeCall, 'settingsFile'>;
  permissions: AttemptPermissions;
  /** Where the runner writes the attempt's settings file. */
  settingsFile: string;
  /**
   * For a brewer that produces commits: the clone its worktree was added to and the attempt's
   * branch, where its commits are counted, never what its worktree says (ADR 0074).
   */
  commits?: { clone: string; branch: string };
  /**
   * The repository's setup: the runner runs it in the worktree before claude starts, in the checks'
   * environment, killed before the attempt's deadline (ADR 0163).
   */
  setup?: { run: SetupRun; deadlineAt: string; env: Env };
  /** The house-yeast rules the plan gave the brewer, which its end records (ADR 0169). */
  houseYeast?: HouseYeastSelection;
}

/** An out doc as the runner found it. */
export type OutDocRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'unread'; reason: string };

export interface ClaudeRunnerDeps {
  /** The `claude` program to start. */
  claude: string;
  plan: (attempt: AttemptStart) => Promise<ClaudeAttemptPlan>;
  stream: StreamProcess;
  /**
   * The process runner a repository's setup runs through: the check sandbox, network kept (ADR
   * 0158). A plan with a setup and no runner for it is blocked on its environment.
   */
  setup?: ExecProcess;
  files: {
    writeSettings: (file: string, settings: AttemptSettings) => void;
    /** Reads the out doc only inside `root`, the worktree. */
    readOutDoc: (file: string, maxBytes: number, root: string) => OutDocRead;
    /**
     * Removes the out doc a run before left, only inside `root`, the worktree, before a run that
     * resumes its session there (ADR 0118); throws when it cannot.
     */
    clearOutDoc: (file: string, root: string) => void;
  };
  now: () => Date;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The commits on the attempt's branch in its clone after the limits' `commitsSince` (ADR 0074). */
  commits: CountCommits;
}

/**
 * One stream line, an event, may hold a whole file the brewer read: well above any file it reads,
 * well below what the engine can hold (ADR 0046).
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** The out doc's text reaches the event log (ADR 0028). */
const MAX_OUT_DOC_BYTES = 1024 * 1024;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// stderr is the CLI's, but it may quote what the brewer wrote: a reason quotes one line of it,
// cut as the stream's are.
const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? '';

/** Reads an out doc of at most `maxBytes`, only a regular file, and only inside `root`. */
export function readOutDocFile(
  file: string,
  maxBytes: number,
  root: string,
  open: (path: string, flags: number) => number = openSync,
  stat: (path: string, options: { bigint: true }) => BigIntStats = statSync,
): OutDocRead {
  const tooLarge: OutDocRead = { kind: 'unread', reason: `it is larger than ${maxBytes} bytes` };
  const notAFile: OutDocRead = { kind: 'unread', reason: 'it is not a regular file' };
  try {
    const found = lstatSync(file, { throwIfNoEntry: false });
    if (found === undefined) return { kind: 'missing' };
    // A link could point the out doc, which reaches the event log, at any file of the machine.
    if (!found.isFile()) return notAFile;
    // So could a linked folder on its path (a junction needs no privilege on Windows), or `..`.
    const real = realpathSync(file);
    if (pathInside(realpathSync(root), real) === undefined) {
      return { kind: 'unread', reason: 'it is outside the worktree' };
    }
    // The identity of the file checked, taken before the open: a folder swapped for a link after
    // the check is followed by the open and by any later look at the same path (#134, review of
    // #136). Big integers, as a Windows file id may not fit a number.
    const checked = stat(real, { bigint: true });
    // Where the platform has it, a link swapped in since the checks is not followed (ADR 0047).
    const fd = open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // O_NOFOLLOW covers only the last part of the path: the file opened must be the one checked.
      const held = fstatSync(fd, { bigint: true });
      // A swap that came before the identity was taken and is still in place moved the real path
      // (review of #136); one made and undone within these few calls is not seen.
      if (held.dev !== checked.dev || held.ino !== checked.ino || realpathSync(file) !== real) {
        return { kind: 'unread', reason: 'it changed while it was read' };
      }
      if (!held.isFile()) return notAFile;
      // A hard link keeps its name in the worktree, but its content may be any file of the volume.
      if (held.nlink > 1n) return { kind: 'unread', reason: 'it has more than one link' };
      if (held.size > BigInt(maxBytes)) return tooLarge;
      // Never more than the limit, even when the file grew since.
      const buffer = Buffer.alloc(maxBytes + 1);
      const length = readSync(fd, buffer, 0, maxBytes + 1, 0);
      if (length > maxBytes) return tooLarge;
      return { kind: 'text', text: buffer.toString('utf8', 0, length) };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { kind: 'unread', reason: messageOf(error) };
  }
}

/**
 * Removes the out doc `file` a run before left in `root`, the worktree, so a resumed run is read by
 * what it writes itself (ADR 0118); nothing when there is none. Throws when it cannot.
 */
export function clearOutDocFile(file: string, root: string): void {
  const found = lstatSync(file, { throwIfNoEntry: false });
  // A folder is no out doc, and the read after the run says so.
  if (found === undefined || found.isDirectory()) return;
  // A linked folder on its path (a junction needs no privilege on Windows), or `..`, could lead
  // out of the worktree; a link in its place goes itself, never the file it points at.
  const real = join(realpathSync(dirname(file)), basename(file));
  if (pathInside(realpathSync(root), real) === undefined) {
    throw new Error(`the out doc ${file} is outside the worktree`);
  }
  unlinkSync(file);
}

/** How the process ended, from what the stream process answered. */
const exitOf = (result: StreamResult): ProcessExit => {
  switch (result.killed) {
    case undefined:
      if (result.exitCode !== null) return { kind: 'exited', code: result.exitCode };
      // A crash or the OOM killer on macOS and Linux: it ran, so it is retried.
      if (result.signal !== undefined) return { kind: 'killed', signal: result.signal };
      return { kind: 'unstartable', reason: cut(result.stderr.trim()) };
    case 'stopped':
    case 'timed-out':
      return { kind: 'stopped' };
    case 'line-too-long':
      return { kind: 'overflowed', what: `a stream line passed ${MAX_LINE_BYTES} bytes` };
    case 'too-much-output':
      return { kind: 'overflowed', what: `stderr passed ${DEFAULT_MAX_OUTPUT_BYTES} bytes` };
    default: {
      const unhandled: never = result.killed;
      throw new Error(`Unhandled kill ${JSON.stringify(unhandled)}`);
    }
  }
};

/**
 * Why the session is not what was asked: the stream's reason, or arguments claude refused, which
 * it says on stderr before it writes any event (ADR 0042).
 */
const environmentOf = (
  seen: StreamFacts,
  exit: ProcessExit,
  stderr: string,
): string | undefined => {
  if (seen.environment !== undefined) return seen.environment;
  if (exit.kind !== 'exited' || exit.code === 0 || seen.lines > 0) return undefined;
  // Past 255 it is a Windows crash status (NTSTATUS), which claude never exits with: a crash.
  if (exit.code > 255) return undefined;
  const said = lastLine(stderr);
  return said === ''
    ? `claude refused to start with exit code ${exit.code}`
    : `claude refused to start: ${cut(said)}`;
};

/** Resolves after `ms`, or at once when `signal` aborts or had aborted. */
export function waitFor(
  ms: number,
  signal: AbortSignal,
  timers: Timers = { set: setTimeout, clear: (timer) => clearTimeout(timer as NodeJS.Timeout) },
): Promise<void> {
  return new Promise<void>((done) => {
    // A stop that came before the wait began costs no wait (review of #136).
    if (signal.aborted) {
      done();
      return;
    }
    const timer = timers.set(done, ms);
    signal.addEventListener(
      'abort',
      () => {
        timers.clear(timer);
        done();
      },
      { once: true },
    );
  });
}

/** How long the runner waits before it starts claude once more after a passing failure. */
const RETRY_MS = 5000;

/**
 * What claude says on stderr when it refuses for a cause the next start meets again: its
 * arguments, its session id, its login (ADR 0042, #134).
 */
const LASTING_REFUSALS = [
  /\bunknown option\b/i,
  /\bargument missing\b/i,
  /\bmissing required argument\b/i,
  /\brequires --/i,
  /\binvalid session id\b/i,
  // A session id a start that wrote its stream has taken (review of #136, claude 2.1.301).
  /\bsession id\b.*\balready in use\b/i,
  /\bnot logged in\b/i,
  /\binvalid api key\b/i,
  /\/login\b/,
];

/** Whether claude failed before its first line for a cause it does not name as lasting. */
const passingPreStreamFailure = (seen: StreamFacts, result: StreamResult): boolean => {
  const exit = exitOf(result);
  if (seen.environment !== undefined) return false;
  if (environmentOf(seen, exit, result.stderr) === undefined) return false;
  return !LASTING_REFUSALS.some((refusal) => refusal.test(result.stderr));
};

/** The facts of a process that never ran. */
const noFacts = (exit: ProcessExit): AttemptFacts => ({
  exit,
  outDoc: undefined,
  denials: 0,
  deniedTools: [],
  turns: 0,
});

/**
 * The reading of a plan's setup, run in its worktree `cwd` through `through`; read as unstarted when
 * the runner has no process runner for it (ADR 0163).
 */
export function setUpFor(
  setup: NonNullable<ClaudeAttemptPlan['setup']>,
  cwd: string,
  through: ExecProcess | undefined,
  { now, signal }: { now: () => Date; signal: AbortSignal },
): Promise<GravityReading> {
  const { run, deadlineAt, env } = setup;
  if (through === undefined) {
    // As a setup that could not start: the reason is the runner's, not the repository's.
    const tail = 'the brewer runner has no process runner for setups';
    return Promise.resolve({ result: 'unstarted', setup: true, command: run.command, tail });
  }
  return runSetup(through, run, { cwd, env, deadlineAt, now, signal });
}

/** A brewer runner over the given stream process and files; unit tests pass fakes. */
export function claudeBrewerRunnerWith(deps: ClaudeRunnerDeps): BrewerRunner {
  const running = new Map<string, () => AttemptProgress>();

  /** The commits after `since` where the plan says to count them; none without a start. */
  const commitsOf = async (
    plan: ClaudeAttemptPlan,
    since: string | undefined,
    signal: AbortSignal,
  ): Promise<CommitsSeen | undefined> => {
    if (since === undefined) return undefined;
    if (plan.commits === undefined) {
      return { kind: 'uncounted', reason: 'the plan names no clone to count them in' };
    }
    const { clone, branch } = plan.commits;
    return deps
      .commits(clone, branch, since, signal)
      .catch((error: unknown): CommitsSeen => ({ kind: 'uncounted', reason: messageOf(error) }));
  };

  const start = (attempt: AttemptStart) => {
    const key = attemptKey.encode(attempt.ref);
    const { limits } = attempt;
    const startedAt = deps.now();
    const stopping = new AbortController();
    let reader: StreamReader | undefined;
    // The stall limit judges claude, so the repository's setup is progress while it runs, and
    // claude's clock starts when it ends (ADR 0027, ADR 0163).
    let settingUp = false;
    let claudeFrom = startedAt;
    running.set(key, () => {
      if (reader !== undefined) return reader.progress();
      return {
        lastProgressAt: settingUp ? deps.now() : claudeFrom,
        turnsWithoutProgress: 0,
        ...(settingUp ? { settingUp } : {}),
      };
    });
    const unstartable = (error: unknown): AttemptEnd => ({
      ending: settleAttempt(noFacts({ kind: 'unstartable', reason: messageOf(error) }), limits),
    });
    const cancelled = (): AttemptEnd => ({
      ending: settleAttempt(noFacts({ kind: 'stopped' }), limits),
    });

    // A stop does not wait for a plan that may never come.
    const aborted = new Promise<undefined>((settle) => {
      stopping.signal.addEventListener('abort', () => settle(undefined), { once: true });
    });

    let given: HouseYeastSelection | undefined;
    const run = async (): Promise<AttemptEnd> => {
      let plan: ClaudeAttemptPlan;
      let args: string[];
      try {
        const prepared = await Promise.race([deps.plan(attempt), aborted]);
        if (prepared === undefined) return cancelled();
        plan = prepared;
        given = plan.houseYeast;
        deps.files.writeSettings(plan.settingsFile, attemptSettings(plan.permissions));
        // A resumed run is read by the out doc it writes, never the one the run before left,
        // such as its needs_input (ADR 0118).
        if (plan.call.session.kind === 'resume') {
          deps.files.clearOutDoc(resolve(plan.cwd, limits.outDoc.file), plan.cwd);
        }
        args = claudeArgs({ ...plan.call, settingsFile: plan.settingsFile });
      } catch (error) {
        return unstartable(error);
      }
      if (stopping.signal.aborted) return cancelled();
      // The repository's setup first, so the brewer finds its dependencies; one that does not
      // pass ends the attempt before claude spends a token (ADR 0163).
      settingUp = true;
      const before =
        plan.setup === undefined
          ? []
          : [
              await setUpFor(plan.setup, plan.cwd, deps.setup, {
                now: deps.now,
                signal: stopping.signal,
              }),
            ];
      settingUp = false;
      if (!before.every(passed)) return { ending: settleReadings(before), readings: before };
      if (before.length > 0) claudeFrom = deps.now();
      const withReadings = (end: AttemptEnd): AttemptEnd =>
        before.length === 0 ? end : { ...end, readings: before };
      const { session, tools } = plan.call;
      const { cwd, env, prompt } = plan;
      /** One start of claude, read by a reader of its own. */
      const once = async (): Promise<{ stream: StreamReader; result: StreamResult }> => {
        const stream = readClaudeStream(
          {
            sessionId: session.id,
            tools,
            maxDenials: limits.maxDenials,
            resumes: session.kind === 'resume',
            worktree: cwd,
          },
          claudeFrom,
        );
        reader = stream;
        const result = await deps.stream(deps.claude, args, {
          cwd,
          env,
          stdin: prompt,
          // On Windows the tree must not outlive a kill (ADR 0039, #128); ignored elsewhere.
          jobObject: true,
          signal: stopping.signal,
          maxLineBytes: MAX_LINE_BYTES,
          // A mismatched init or a denial at maxDenials stops the attempt at that line.
          onLine: (line) => {
            if (stream.read(line, deps.now()) === 'stop') stopping.abort();
          },
        });
        return { stream, result };
      };
      let stream: StreamReader;
      let result: StreamResult;
      try {
        ({ stream, result } = await once());
        // A failure before the first line that names no lasting cause may pass (#134): start
        // claude once more, and call it the environment only when that fails too.
        if (passingPreStreamFailure(stream.facts(), result)) {
          await deps.wait(RETRY_MS, stopping.signal);
          if (stopping.signal.aborted) return withReadings(cancelled());
          ({ stream, result } = await once());
        }
      } catch (error) {
        return withReadings(unstartable(error));
      }
      const seen = stream.facts();
      const exit = exitOf(result);
      const out = deps.files.readOutDoc(
        resolve(plan.cwd, limits.outDoc.file),
        MAX_OUT_DOC_BYTES,
        plan.cwd,
      );
      // What the next step starts from is the attempt's branch in the clone, not the stream, nor
      // the worktree's own git files, which the brewer can write (ADR 0074).
      // Not after a stop: the runner's own (a limit it saw in the stream) settles before any count.
      const stopped = stopping.signal.aborted;
      const commits = stopped
        ? undefined
        : await commitsOf(plan, limits.commitsSince, stopping.signal);
      // What the stream reported stays with the attempt however it ends from here.
      const reported = {
        ...(seen.usage === undefined ? {} : { usage: seen.usage }),
        // A claude that never started took nothing (ADR 0172).
        ...(exit.kind === 'unstartable' ? {} : { receipt: stream.receipt() }),
        ...(seen.session === undefined ? {} : { session: seen.session }),
      };
      // A stop while counting kills git: the attempt was stopped, git did not fail.
      if (!stopped && stopping.signal.aborted) return withReadings({ ...cancelled(), ...reported });
      const facts: AttemptFacts = {
        environment: environmentOf(seen, exit, result.stderr),
        unresumed: seen.unresumed,
        exit,
        outDoc: out.kind === 'text' ? out.text : undefined,
        outDocUnread: out.kind === 'unread' ? out.reason : undefined,
        streamError: seen.streamError,
        usageLimit: seen.usageLimit,
        spendLimit: seen.spendLimit,
        ...(seen.garbage === undefined ? {} : { garbage: seen.garbage }),
        denials: seen.denials,
        deniedTools: seen.deniedTools,
        turns: seen.turns,
        ...(commits === undefined ? {} : { commits }),
      };
      // The text as read, valid or not, for the state branch (ADR 0103).
      const outDoc = facts.outDoc === undefined ? {} : { outDoc: facts.outDoc };
      return withReadings({ ending: settleAttempt(facts, limits), ...reported, ...outDoc });
    };

    // However it ends once it has a plan, the rules the plan gave the brewer go with it (ADR 0169).
    const ended = run()
      .then((end) => (given === undefined ? end : { ...end, houseYeast: given }))
      .finally(() => running.delete(key));
    return { ended, stop: () => stopping.abort() };
  };

  return {
    start,
    progress: (ref) => running.get(attemptKey.encode(ref))?.(),
  };
}

/** The runner with the real process runner, files and clock. */
export function claudeBrewerRunner(
  options: Pick<ClaudeRunnerDeps, 'claude' | 'plan' | 'setup'>,
): BrewerRunner {
  return claudeBrewerRunnerWith({
    ...options,
    stream: streamProcess,
    files: {
      writeSettings: writeAttemptSettings,
      readOutDoc: readOutDocFile,
      clearOutDoc: clearOutDocFile,
    },
    now: () => new Date(),
    wait: waitFor,
    commits: countCommits(runGit),
  });
}
