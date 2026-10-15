// The brewer runner (ADR 0003): starts an attempt, reports its progress to the supervisor, and ends
// it with a typed outcome (ADR 0005). The real runner drives the `claude` CLI; tests use a fake.
// Both turn what the process did into the outcome through settleAttempt, so the rules are shared.

import type { Usage } from '../schemas/events.ts';
import type { OutDocFrontmatter } from '../schemas/out-doc.ts';
import type { z } from '../schemas/zod.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { Ending } from './decide.ts';
import type { ProgressSource } from './supervisor.ts';

/** What the runner enforces for one attempt and where the brewer reports its outcome. */
export interface AttemptLimits {
  /** The out doc the brewer must write (`output.doc`), and the schema of its frontmatter. */
  outDoc: { file: string; schema: z.ZodType<OutDocFrontmatter> };
  /** Turns before the runner stops the brewer: its budget is exceeded. */
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
  /** Permission denials in the event stream. */
  denials: number;
  /** Turns the brewer took. */
  turns: number;
}

/** The outcome of an attempt from what the runner saw (ADR 0005: no out doc is never success). */
export function settleAttempt(_facts: AttemptFacts, _limits: AttemptLimits): Ending {
  throw new Error('not implemented');
}
