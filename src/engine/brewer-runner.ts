// The brewer runner (ADR 0003): starts an attempt, reports its progress to the supervisor, and ends
// it with a typed outcome (ADR 0005). The real runner drives the `claude` CLI; tests use a fake.
// Both turn what the process did into the outcome through settleAttempt, so the rules are shared.

import type { GravityReading, Usage } from '../schemas/events.ts';
import { type OutDocFrontmatter, readOutDoc } from '../schemas/out-doc.ts';
import type { z } from '../schemas/zod.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { Ending } from './decide.ts';
import type { ProgressSource } from './supervisor.ts';

/** What the runner enforces for one attempt and where the brewer reports its outcome. */
export interface AttemptLimits {
  /** The out doc the brewer must write (`output.doc`), and the schema of its frontmatter. */
  outDoc: { file: string; schema: z.ZodType<OutDocFrontmatter> };
  /** Turns the brewer may take; the runner stops it on the first turn past them: its budget is exceeded. */
  maxTurns?: number;
  /** Permission denials before the runner stops the brewer: it is blocked by its environment. */
  maxDenials?: number;
}

export interface AttemptStart {
  ref: AttemptRef;
  limits: AttemptLimits;
}

/** How an attempt ended, with the tokens it used when the stream reported them. */
export interface AttemptEnd {
  ending: Ending;
  usage?: Usage;
  /** What a check step read, one per check (ADR 0069); a brewer's attempt has none. */
  readings?: readonly GravityReading[];
  /** The session claude set up, when its init matched what was asked (ADR 0046, ADR 0047). */
  session?: { sessionId: string; model: string; claudeVersion: string };
}

export interface RunningAttempt {
  /** Settles once with how the attempt ended. */
  readonly ended: Promise<AttemptEnd>;
  /**
   * Stops the brewer's process tree (deadline, stall, cancel, or an attempt abandoned when its
   * batch got Stuck); `ended` then settles as cancelled. Does nothing once the attempt ended.
   */
  stop(): void;
}

/** Runs brewer attempts; `progress` reports each running one to the supervisor (ADR 0027). */
export interface BrewerRunner extends ProgressSource {
  start(attempt: AttemptStart): RunningAttempt;
}

/** How the brewer's process ended. */
export type ProcessExit =
  | { kind: 'exited'; code: number }
  /** Ended by a signal the runner did not send. */
  | { kind: 'killed'; signal: string }
  /** The runner stopped it: a limit was reached, or the engine stopped the attempt. */
  | { kind: 'stopped' }
  /** The process could not be started at all (the CLI is missing, the settings could not be written). */
  | { kind: 'unstartable'; reason: string }
  /** The runner stopped it because its output passed a limit: a stream line, or stderr. */
  | { kind: 'overflowed'; what: string };

/** What the runner saw of one attempt. */
export interface AttemptFacts {
  /**
   * Why claude did not set up the session the runner asked for: its init event (tools, permission
   * mode, MCP servers, skills; the runner stops the attempt when it sees it), a result before
   * init, a lasting error before the first model reply, or refused arguments (ADR 0046, ADR 0047).
   */
  environment?: string | undefined;
  exit: ProcessExit;
  /** The out doc's text, or `undefined` when the brewer did not write it. */
  outDoc: string | undefined;
  /** Why the result event reported an error (`is_error`, ADR 0042), when it did. */
  streamError?: string | undefined;
  /** Why the runner did not read the out doc it found (larger than its limit, not a file). */
  outDocUnread?: string | undefined;
  /** The first line of the event stream that was not a stream-json event. */
  garbage?: string;
  /** Permission denials in the event stream, every one counted. */
  denials: number;
  /** The tools denied, each once, in the order they were first denied (ADR 0006: named). */
  deniedTools: readonly string[];
  /** Turns the brewer took. */
  turns: number;
}

/** The permission denials of an attempt so far. */
export type Denials = Pick<AttemptFacts, 'denials' | 'deniedTools'>;

/** The denials after one more of `tool`: counted always, its name kept once. */
export function noteDenial(seen: Denials, tool: string): Denials {
  // Each name once, so a storm of the same denial cannot grow the list.
  const deniedTools = seen.deniedTools.includes(tool)
    ? seen.deniedTools
    : [...seen.deniedTools, tool];
  return { denials: seen.denials + 1, deniedTools };
}

/** How much of a garbage line a reason quotes: the stream is untrusted and may be huge. */
const quoted = 120;

const failed = (retryable: boolean, reason: string): Ending => ({
  kind: 'failed',
  retryable,
  reason,
});

/**
 * The outcome of an attempt from what the runner saw, the first rule that applies winning: a
 * limit the runner enforced, then how the process ended, then the stream, then the out doc
 * (ADR 0005: a missing or invalid out doc is a failure, never success).
 */
export function settleAttempt(facts: AttemptFacts, limits: AttemptLimits): Ending {
  const { exit, denials, turns } = facts;
  const { maxDenials, maxTurns, outDoc } = limits;
  // Another attempt would meet the same environment; a human must fix it (ADR 0046).
  if (facts.environment !== undefined) {
    const summary = `claude did not set up the session the runner asked for: ${facts.environment}`;
    return { kind: 'blocked', blockerKind: 'environment', summary };
  }
  if (exit.kind === 'unstartable') {
    return failed(false, `the brewer could not start: ${exit.reason}`);
  }
  // Another attempt would hit the same wall (brewers-and-recipes §1.1).
  if (maxDenials !== undefined && denials >= maxDenials) {
    // The human needs to know what to allow (ADR 0006).
    const tools = facts.deniedTools.length > 0 ? `; denied: ${facts.deniedTools.join(', ')}` : '';
    const summary = `${denials} permission denials, maxDenials is ${maxDenials}${tools}`;
    return { kind: 'blocked', blockerKind: 'environment', summary };
  }
  // The same budget would run out again.
  if (maxTurns !== undefined && turns > maxTurns) {
    return failed(false, `budget exceeded: ${turns} turns, maxTurns is ${maxTurns}`);
  }
  switch (exit.kind) {
    case 'stopped':
      return { kind: 'cancelled' };
    case 'killed':
      return failed(true, `the brewer process was killed by ${exit.signal}`);
    case 'overflowed':
      return failed(true, `the brewer's output passed a limit: ${exit.what}`);
    case 'exited':
      // is_error decides, not the exit code: an API error can end with a clean exit (ADR 0042).
      if (facts.streamError !== undefined) {
        return failed(true, `claude reported an error: ${facts.streamError}`);
      }
      if (exit.code !== 0) return failed(true, `the brewer process exited with code ${exit.code}`);
      break;
    default: {
      const unhandled: never = exit;
      throw new Error(`Unhandled exit ${JSON.stringify(unhandled)}`);
    }
  }
  if (facts.garbage !== undefined) {
    const line = JSON.stringify(facts.garbage.slice(0, quoted));
    return failed(true, `the event stream is not stream-json: ${line}`);
  }
  if (facts.outDocUnread !== undefined) {
    return failed(true, `the out doc ${outDoc.file} was not read: ${facts.outDocUnread}`);
  }
  if (facts.outDoc === undefined) return failed(true, `the out doc ${outDoc.file} is missing`);
  const read = readOutDoc(facts.outDoc, outDoc.schema);
  if (!read.valid) return failed(true, `the out doc ${outDoc.file} is invalid: ${read.reason}`);
  const frontmatter = read.frontmatter;
  switch (frontmatter.status) {
    case 'done':
      return { kind: 'succeeded', output: frontmatter };
    case 'needs_input':
      return { kind: 'needs_input', questions: frontmatter.questions };
    case 'blocked':
      return {
        kind: 'blocked',
        blockerKind: frontmatter.blockerKind,
        summary: frontmatter.summary,
      };
    case 'failed':
      return failed(true, `the brewer failed: ${frontmatter.summary}`);
    default: {
      const unhandled: never = frontmatter;
      throw new Error(`Unhandled out-doc status ${JSON.stringify(unhandled)}`);
    }
  }
}
