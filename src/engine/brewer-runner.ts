// The brewer runner (ADR 0003): starts an attempt, reports its progress to the supervisor, and ends
// it with a typed outcome (ADR 0005). The real runner drives the `claude` CLI; tests use a fake.
// Both turn what the process did into the outcome through settleAttempt, so the rules are shared.

import type { Usage } from '../schemas/events.ts';
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
  /** The process could not be started at all (the CLI is missing, an argument was refused). */
  | { kind: 'unstartable'; reason: string };

/** What the runner saw of one attempt. */
export interface AttemptFacts {
  exit: ProcessExit;
  /** The out doc's text, or `undefined` when the brewer did not write it. */
  outDoc: string | undefined;
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
export function noteDenial(_seen: Denials, _tool: string): Denials {
  throw new Error('not implemented');
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
  if (exit.kind === 'unstartable') {
    return failed(false, `the brewer could not start: ${exit.reason}`);
  }
  // Another attempt would hit the same wall (brewers-and-recipes §1.1).
  if (maxDenials !== undefined && denials >= maxDenials) {
    const summary = `${denials} permission denials, maxDenials is ${maxDenials}`;
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
    case 'exited':
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
