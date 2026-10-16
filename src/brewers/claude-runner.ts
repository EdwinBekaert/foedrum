// The real brewer runner (ADR 0003, ADR 0028, ADR 0047): runs an attempt as one `claude` process
// with the runner's own settings file, its prompt on stdin, inside a Job Object on Windows, and
// reads its stream line by line. What it saw goes through settleAttempt, as with the fake.

import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { attemptKey } from '../engine/attempt-key.ts';
import {
  type AttemptEnd,
  type AttemptFacts,
  type AttemptStart,
  type BrewerRunner,
  type ProcessExit,
  settleAttempt,
} from '../engine/brewer-runner.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  type StreamProcess,
  type StreamResult,
} from '../platform/processes.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import { type AttemptPermissions, attemptSettings } from './attempt-settings.ts';
import { type ClaudeCall, claudeArgs } from './claude-command.ts';
import { readClaudeStream, type StreamFacts, type StreamReader } from './claude-stream.ts';
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
  files: {
    writeSettings: (file: string, settings: AttemptSettings) => void;
    readOutDoc: (file: string, maxBytes: number) => OutDocRead;
  };
  now: () => Date;
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

// stderr is the CLI's, but it may quote what the brewer wrote: a reason quotes one line of it.
const SHORT = 200;
const cut = (text: string): string => (text.length > SHORT ? `${text.slice(0, SHORT)}…` : text);
const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? '';

/** Reads an out doc of at most `maxBytes`, and only a regular file. */
export function readOutDocFile(file: string, maxBytes: number): OutDocRead {
  const tooLarge: OutDocRead = { kind: 'unread', reason: `it is larger than ${maxBytes} bytes` };
  try {
    const found = lstatSync(file, { throwIfNoEntry: false });
    if (found === undefined) return { kind: 'missing' };
    // A link could point the out doc, which reaches the event log, at any file of the machine.
    if (!found.isFile()) return { kind: 'unread', reason: 'it is not a regular file' };
    const fd = openSync(file, 'r');
    try {
      if (fstatSync(fd).size > maxBytes) return tooLarge;
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

/** How the process ended, from what the stream process answered. */
const exitOf = (result: StreamResult): ProcessExit => {
  switch (result.killed) {
    case undefined:
      return result.exitCode === null
        ? { kind: 'unstartable', reason: cut(result.stderr.trim()) }
        : { kind: 'exited', code: result.exitCode };
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
  const said = lastLine(stderr);
  return said === ''
    ? `claude refused to start with exit code ${exit.code}`
    : `claude refused to start: ${cut(said)}`;
};

/** The facts of a process that never ran. */
const noFacts = (exit: ProcessExit): AttemptFacts => ({
  exit,
  outDoc: undefined,
  denials: 0,
  deniedTools: [],
  turns: 0,
});

/** A brewer runner over the given stream process and files; unit tests pass fakes. */
export function claudeBrewerRunnerWith(deps: ClaudeRunnerDeps): BrewerRunner {
  const running = new Map<string, () => AttemptProgress>();

  const start = (attempt: AttemptStart) => {
    const key = attemptKey.encode(attempt.ref);
    const { limits } = attempt;
    const startedAt = deps.now();
    const stopping = new AbortController();
    let reader: StreamReader | undefined;
    running.set(
      key,
      () => reader?.progress() ?? { lastProgressAt: startedAt, turnsWithoutProgress: 0 },
    );
    const unstartable = (error: unknown): AttemptEnd => ({
      ending: settleAttempt(noFacts({ kind: 'unstartable', reason: messageOf(error) }), limits),
    });

    const run = async (): Promise<AttemptEnd> => {
      let plan: ClaudeAttemptPlan;
      let args: string[];
      try {
        plan = await deps.plan(attempt);
        deps.files.writeSettings(plan.settingsFile, attemptSettings(plan.permissions));
        args = claudeArgs({ ...plan.call, settingsFile: plan.settingsFile });
      } catch (error) {
        return unstartable(error);
      }
      if (stopping.signal.aborted) {
        return { ending: settleAttempt(noFacts({ kind: 'stopped' }), limits) };
      }
      const { session, tools } = plan.call;
      const stream = readClaudeStream(
        { sessionId: session.id, tools, maxDenials: limits.maxDenials },
        startedAt,
      );
      reader = stream;
      let result: StreamResult;
      try {
        result = await deps.stream(deps.claude, args, {
          cwd: plan.cwd,
          env: plan.env,
          stdin: plan.prompt,
          // On Windows the tree must not outlive a kill (ADR 0039, #128); ignored elsewhere.
          jobObject: true,
          signal: stopping.signal,
          maxLineBytes: MAX_LINE_BYTES,
          // A mismatched init or a denial at maxDenials stops the attempt at that line.
          onLine: (line) => {
            if (stream.read(line, deps.now()) === 'stop') stopping.abort();
          },
        });
      } catch (error) {
        return unstartable(error);
      }
      const seen = stream.facts();
      const exit = exitOf(result);
      const out = deps.files.readOutDoc(resolve(plan.cwd, limits.outDoc.file), MAX_OUT_DOC_BYTES);
      const facts: AttemptFacts = {
        environment: environmentOf(seen, exit, result.stderr),
        exit,
        outDoc: out.kind === 'text' ? out.text : undefined,
        outDocUnread: out.kind === 'unread' ? out.reason : undefined,
        streamError: seen.streamError,
        ...(seen.garbage === undefined ? {} : { garbage: seen.garbage }),
        denials: seen.denials,
        deniedTools: seen.deniedTools,
        turns: seen.turns,
      };
      return {
        ending: settleAttempt(facts, limits),
        ...(seen.usage === undefined ? {} : { usage: seen.usage }),
        ...(seen.session === undefined ? {} : { session: seen.session }),
      };
    };

    const ended = run().finally(() => running.delete(key));
    return { ended, stop: () => stopping.abort() };
  };

  return {
    start,
    progress: (ref) => running.get(attemptKey.encode(ref))?.(),
  };
}
