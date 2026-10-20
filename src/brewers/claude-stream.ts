// Reading claude's stream-json (ADR 0042, ADR 0046, ADR 0047): one stdout line at a time, the
// init check first, then the facts settleAttempt decides on and the progress the stall watchdog
// reads. Pure: the runner hands it each line with the time it came.

import {
  type AttemptFacts,
  type Denials,
  noteDenial,
  type UsageLimit,
} from '../engine/brewer-runner.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import {
  ClaudeAssistant,
  ClaudeDenial,
  ClaudeEvent,
  ClaudeResult,
  ClaudeToolResult,
  ClaudeToolUse,
  ClaudeUser,
} from '../schemas/claude-stream.ts';
import type { Usage } from '../schemas/events.ts';
import { type AskedSession, checkInit, type SessionFacts } from './claude-init.ts';

/** What the runner asked for, and when it stops the attempt itself. */
export interface StreamAsk extends AskedSession {
  /** Stops the attempt at the denial that reaches it. */
  maxDenials?: number | undefined;
}

/** What the stream showed, for settleAttempt. */
export type StreamFacts = Pick<
  AttemptFacts,
  'environment' | 'streamError' | 'usageLimit' | 'garbage' | 'denials' | 'deniedTools' | 'turns'
> & {
  /** The session claude set up, once its init matched what was asked. */
  session?: SessionFacts;
  /** The result's tokens. */
  usage?: Usage;
  /** How many lines came, empty ones included. */
  lines: number;
};

export interface StreamReader {
  /** Reads one stdout line that came at `now`; `stop` when the runner must stop the attempt. */
  read(line: string, now: Date): 'go' | 'stop';
  facts(): StreamFacts;
  /** For the stall watchdog: when the brewer last wrote a file or committed, and turns since. */
  progress(): AttemptProgress;
}

// The stream is untrusted and may be huge: what a reason quotes of it is cut short.
const SHORT = 200;
export const cut = (text: string): string =>
  text.length > SHORT ? `${text.slice(0, SHORT)}…` : text;

/** The tools that write a file; a shell command counts only when it commits. */
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELLS = new Set(['Bash', 'PowerShell']);
/**
 * Whether a shell command runs `git … commit`: `commit` after `git` within one command between
 * separators. The command is model output, so each test is linear (review of #133).
 */
const commits = (command: string): boolean => simpleCommands(command).some(runsCommit);

/**
 * The words of each simple command, split at `;`, `&`, `|` and line ends outside quotes, a quoted
 * word as one word without its quotes (review of #136). One linear pass.
 */
const simpleCommands = (command: string): string[][] => {
  const found: string[][] = [[]];
  for (const token of command.match(/"[^"]*"|'[^']*'|[\n;&|]|[^\s;&|"']+|["']/g) ?? []) {
    if (/^[\n;&|]$/.test(token)) found.push([]);
    else found.at(-1)?.push(/^(["']).*\1$/s.test(token) ? token.slice(1, -1) : token);
  }
  return found;
};

/** git's global options that take the next word as their value (unless given with `=`). */
const VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);

/**
 * Whether one simple command is `git … commit`: after variables, git itself (by any path, with or
 * without `.exe`), then its global options, the first word is `commit` (#134).
 */
const runsCommit = (words: readonly string[]): boolean => {
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '')) at += 1;
  if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(words[at] ?? '')) return false;
  at += 1;
  while (at < words.length && (words[at] ?? '').startsWith('-')) {
    at += VALUED.has(words[at] ?? '') ? 2 : 1;
  }
  return words[at] === 'commit';
};

const writes = (name: string, input: Record<string, unknown>): boolean =>
  WRITERS.has(name) ||
  (SHELLS.has(name) && typeof input.command === 'string' && commits(input.command));

/**
 * Errors of a failed call before the first reply that the next attempt would meet again: the
 * environment. A rate limit, an overloaded or failing server, or an unknown error may pass.
 */
const LASTING = new Set([
  'authentication_failed',
  'billing_error',
  'invalid_request',
  'model_not_found',
]);

/**
 * A run-out usage window, only in the forms Claude Code's error reference gives (ADR 0091): the
 * whole text, one line, such as `You've hit your weekly limit · resets Mon 12:00am`.
 */
const USAGE_LIMIT = /^You've hit your (session|weekly|Opus|Sonnet) limit · resets (\S.*)$/;

const usageLimitIn = (text: string): UsageLimit | undefined => {
  const found = USAGE_LIMIT.exec(text.trim());
  if (found === null) return undefined;
  // The pattern only matches one of the four limits and a reset.
  const [, limit, resets = ''] = found;
  return { limit: limit as UsageLimit['limit'], resets: cut(resets) };
};

/** The usage limit an error result names, in its `result` or one of its `errors`. */
const usageLimitOf = (result: ClaudeResult): UsageLimit | undefined =>
  [result.result ?? '', ...(result.errors ?? [])].map(usageLimitIn).find((it) => it !== undefined);

/** Why a result reported an error: its terminal reason, then what it said. */
const errorOf = (result: ClaudeResult): string => {
  const why = result.terminal_reason ?? result.subtype;
  const said = result.errors?.[0] ?? result.result;
  return cut(said === undefined || said === '' ? why : `${why}: ${said}`);
};

/** The text of a message claude made up for a failed call. */
const textOf = (content: readonly { type: string; text?: unknown }[]): string =>
  content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join(' ')
    .trim();

/** A reader for one attempt's stream, which started at `startedAt`. */
export function readClaudeStream(asked: StreamAsk, startedAt: Date): StreamReader {
  let session: SessionFacts | undefined;
  let environment: string | undefined;
  let streamError: string | undefined;
  let usageLimit: UsageLimit | undefined;
  let garbage: string | undefined;
  let usage: Usage | undefined;
  let denials: Denials = { denials: 0, deniedTools: [] };
  let lines = 0;
  let stopped = false;
  // Whether the model has replied: an error before that is the environment's (#11, item 4).
  let replied = false;
  // Turns: the main thread's messages by id while it runs, the result's num_turns at the end.
  const messages = new Set<string>();
  let finalTurns: number | undefined;
  const turns = (): number => finalTurns ?? messages.size;
  // Progress: the calls that write, and when one last came back without an error.
  const writing = new Set<string>();
  let lastProgressAt = startedAt;
  let turnsAtProgress = 0;

  const failBeforeReply = (why: string): void => {
    if (!replied && environment === undefined) {
      environment = cut(`claude failed before the model replied: ${why}`);
    }
  };

  const readResult = (result: ClaudeResult): void => {
    if (result.num_turns !== undefined) finalTurns = result.num_turns;
    if (result.usage !== undefined) {
      usage = {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        cacheReadTokens: result.usage.cache_read_input_tokens,
        cacheWriteTokens: result.usage.cache_creation_input_tokens,
      };
    }
    if (!result.is_error) return;
    streamError = errorOf(result);
    usageLimit = usageLimitOf(result);
  };

  const beforeInit = (event: unknown, type: string, subtype: unknown): 'go' | 'stop' => {
    // Other system events can come first (ui_invalidate, with an API key; ADR 0046).
    if (type === 'system' && subtype !== 'init') return 'go';
    // A run that ends before its session starts: a missing session to resume, no sandbox.
    const result = ClaudeResult.safeParse(event);
    if (result.success) {
      readResult(result.data);
      const said = result.data.errors?.[0] ?? result.data.result ?? errorOf(result.data);
      environment = `claude ended before the session started: ${cut(said)}`;
      return 'go';
    }
    const check = checkInit(event, asked);
    if (check.kind === 'mismatch') {
      environment = check.reason;
      stopped = true;
      return 'stop';
    }
    session = check.session;
    return 'go';
  };

  const readAssistant = (event: ClaudeAssistant): void => {
    if (event.error !== undefined) {
      if (!LASTING.has(event.error)) return;
      const text = textOf(event.message.content);
      failBeforeReply(text === '' ? event.error : `${event.error}: ${text}`);
      return;
    }
    replied = true;
    if (event.parent_tool_use_id === null || event.parent_tool_use_id === undefined) {
      messages.add(event.message.id);
    }
    for (const block of event.message.content) {
      const use = ClaudeToolUse.safeParse(block);
      if (use.success && writes(use.data.name, use.data.input)) writing.add(use.data.id);
    }
  };

  const readUser = (event: ClaudeUser, now: Date): void => {
    if (typeof event.message.content === 'string') return;
    for (const block of event.message.content) {
      const result = ClaudeToolResult.safeParse(block);
      if (!result.success || !writing.delete(result.data.tool_use_id)) continue;
      if (result.data.is_error === true) continue;
      lastProgressAt = now;
      turnsAtProgress = turns();
    }
  };

  const readEvent = (parsed: unknown, type: string, now: Date): 'go' | 'stop' => {
    switch (type) {
      case 'assistant': {
        const assistant = ClaudeAssistant.safeParse(parsed);
        if (assistant.success) readAssistant(assistant.data);
        return 'go';
      }
      case 'user': {
        const user = ClaudeUser.safeParse(parsed);
        if (user.success) readUser(user.data, now);
        return 'go';
      }
      case 'result': {
        const result = ClaudeResult.safeParse(parsed);
        if (result.success) readResult(result.data);
        else streamError ??= 'the result event could not be read';
        return 'go';
      }
      case 'system': {
        const denial = ClaudeDenial.safeParse(parsed);
        if (!denial.success) return 'go';
        denials = noteDenial(denials, denial.data.tool_name);
        const { maxDenials } = asked;
        if (maxDenials === undefined || denials.denials < maxDenials) return 'go';
        stopped = true;
        return 'stop';
      }
      default:
        // Every other type, including those claude adds later (ADR 0042).
        return 'go';
    }
  };

  const read = (line: string, now: Date): 'go' | 'stop' => {
    if (stopped) return 'stop';
    lines += 1;
    if (line === '') return 'go';
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const event = ClaudeEvent.safeParse(parsed);
    if (!event.success) {
      garbage ??= line.slice(0, SHORT);
      return 'go';
    }
    const { type, subtype } = event.data;
    if (session === undefined) return beforeInit(parsed, type, subtype);
    return readEvent(parsed, type, now);
  };

  return {
    read,
    facts: () => ({
      ...(session === undefined ? {} : { session }),
      ...(environment === undefined ? {} : { environment }),
      ...(streamError === undefined ? {} : { streamError }),
      ...(usageLimit === undefined ? {} : { usageLimit }),
      ...(garbage === undefined ? {} : { garbage }),
      ...denials,
      turns: turns(),
      ...(usage === undefined ? {} : { usage }),
      lines,
    }),
    progress: () => ({ lastProgressAt, turnsWithoutProgress: turns() - turnsAtProgress }),
  };
}
