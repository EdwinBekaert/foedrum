// The brewer runner (ADR 0003): starts an attempt, reports its progress to the supervisor, and ends
// it with a typed outcome (ADR 0005). The real runner drives the `claude` CLI; tests use a fake.
// Both turn what the process did into the outcome through settleAttempt, so the rules are shared.

import type { GravityReading, Receipt, Usage } from '../schemas/events.ts';
import type { HouseYeastSelection } from '../schemas/house-yeast.ts';
import { type OutDocFrontmatter, readOutDoc, tastingOf } from '../schemas/out-doc.ts';
import type { ScanFinding } from '../schemas/store.ts';
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
  /**
   * For a brewer that produces commits: the commit its worktree started at. A `done` out doc then
   * needs a commit after it (ADR 0074).
   */
  commitsSince?: string;
  /** For a Taster's blocking step: a `done` with the verdict `changes` is blocked by findings (ADR 0161). */
  blocking?: boolean;
  /**
   * The driver can resume the attempt's session: a claude step with a worktree manager that
   * recreates worktrees. A run past `maxTurns` after claude's init then fails retryably (ADR 0175).
   */
  resumable?: boolean;
}

export interface AttemptStart {
  ref: AttemptRef;
  limits: AttemptLimits;
}

/** How an attempt ended, with the tokens it used when the stream reported them. */
export interface AttemptEnd {
  ending: Ending;
  usage?: Usage;
  /** What the attempt took, when the runner read its stream (ADR 0172). */
  receipt?: Receipt;
  /**
   * What a check step read, one per check (ADR 0069); a brewer's attempt, its repository's setup's
   * when it has one (ADR 0163).
   */
  readings?: readonly GravityReading[];
  /** The house-yeast rules the attempt's plan gave it (ADR 0169). */
  houseYeast?: HouseYeastSelection;
  /** The session claude set up, when its init matched what was asked (ADR 0046, ADR 0047). */
  session?: { sessionId: string; model: string; claudeVersion: string };
  /**
   * The out doc's text as the runner read it, valid or not; model output, which the state branch
   * keeps and nothing follows (ADR 0103).
   */
  outDoc?: string;
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

/** What git said of the commits an attempt made after its worktree's start (ADR 0074). */
export type CommitsSeen =
  | { kind: 'counted'; count: number }
  /** The start commit is no ancestor of HEAD: the brewer rewrote it. */
  | { kind: 'rewritten' }
  /** git could not answer. */
  | { kind: 'uncounted'; reason: string };

/**
 * What the push's secret scan found in an attempt's commits after its start (ADR 0187): no
 * finding when they may go on.
 */
export type CommitsScanned =
  | { kind: 'scanned'; findings: readonly ScanFinding[] }
  /** git could not answer. */
  | { kind: 'unscanned'; reason: string };

/**
 * A usage window of claude's subscription that ran out, as claude named it (ADR 0091): which
 * limit, and its reset as claude wrote it (`3:45pm`, `Mon 12:00am`).
 */
export interface UsageLimit {
  limit: 'session' | 'weekly' | 'Opus' | 'Sonnet';
  resets: string;
}

/**
 * A spend limit or a credit balance that refuses every request until a human acts (ADR 0129):
 * which spend limit claude named, or a credit balance that is too low.
 */
export type SpendLimit =
  | {
      kind: 'spend';
      limit:
        | 'monthly spend limit'
        | 'individual spend limit'
        | "org's monthly spend limit"
        | "channel's monthly spend limit"
        | "team's shared budget"
        | 'individual usage limit';
    }
  | { kind: 'credit' };

/** What the runner saw of one attempt. */
export interface AttemptFacts {
  /**
   * Why claude did not set up the session the runner asked for: its init event (tools, permission
   * mode, MCP servers, skills; the runner stops the attempt when it sees it), a result before
   * init, a lasting error before the first model reply, or refused arguments (ADR 0046, ADR 0047).
   */
  environment?: string | undefined;
  /**
   * Why claude could not resume the session the runner asked it to: a result before init when it
   * resumes one, as when the transcript is gone. The next attempt starts fresh (ADR 0117).
   */
  unresumed?: string | undefined;
  exit: ProcessExit;
  /** The out doc's text, or `undefined` when the brewer did not write it. */
  outDoc: string | undefined;
  /** Why the result event reported an error (`is_error`, ADR 0042), when it did. */
  streamError?: string | undefined;
  /** The usage window the error result said ran out, in one of the documented messages. */
  usageLimit?: UsageLimit | undefined;
  /** The spend limit or credit balance the error result said refused it, as documented. */
  spendLimit?: SpendLimit | undefined;
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
  /** Whether claude's init report came, so the session it set up can be resumed (ADR 0175). */
  sessionStarted?: boolean;
  /** The commits since the limits' `commitsSince`, when they name one. */
  commits?: CommitsSeen;
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
 * A `done` of a brewer that produces commits, by what git said of its commits after `since`
 * (ADR 0074): without one its work never reached the task tree, so a human sees why, unless a
 * Finer says there was nothing to simplify (ADR 0166).
 */
function doneWithCommits(
  seen: CommitsSeen = { kind: 'uncounted', reason: 'the runner did not count them' },
  since: string,
  output: OutDocFrontmatter,
): Ending {
  const start = since.slice(0, 7);
  const unchanged = 'unchanged' in output && output.unchanged !== undefined;
  switch (seen.kind) {
    case 'counted':
      if (unchanged && seen.count > 0) {
        return failed(
          true,
          `the out doc says nothing was simplified, but the brewer made ${seen.count} commit${seen.count === 1 ? '' : 's'} since ${start}`,
        );
      }
      if (unchanged || seen.count > 0) return { kind: 'succeeded', output };
      // Not retried: a brewer that found nothing to change would find it again.
      return {
        kind: 'blocked',
        blockerKind: 'divergence',
        summary: `the out doc says done, but the brewer made no commit since ${start}: ${output.summary}`,
      };
    case 'rewritten':
      return failed(true, `the brewer rewrote ${start}, the commit its worktree started at`);
    case 'uncounted': {
      const summary = `the commits since ${start} were not counted: ${seen.reason}`;
      return { kind: 'blocked', blockerKind: 'environment', summary };
    }
    default: {
      const unhandled: never = seen;
      throw new Error(`Unhandled commits ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Why no request goes through, and what a human does before a retry. */
function spendSummary(spendLimit: SpendLimit): string {
  switch (spendLimit.kind) {
    case 'spend':
      return `claude hit its ${spendLimit.limit}: no request goes through until the limit is raised, then retry the step`;
    case 'credit':
      return "claude's credit balance is too low: no request goes through until credits are added, then retry the step";
    default: {
      const unhandled: never = spendLimit;
      throw new Error(`Unhandled spend limit ${JSON.stringify(unhandled)}`);
    }
  }
}

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
  // claude refuses every request until the window resets: another attempt now would be refused
  // too, so the engine holds the brewers until the reset claude named (ADR 0091, ADR 0206).
  if (facts.usageLimit !== undefined) {
    const { limit, resets } = facts.usageLimit;
    const summary = `claude hit its ${limit} limit, which resets ${resets}`;
    return { kind: 'blocked', blockerKind: 'environment', summary, usageLimit: facts.usageLimit };
  }
  // Nothing resets by itself: no request goes through until a human acts (ADR 0129).
  if (facts.spendLimit !== undefined) {
    const summary = spendSummary(facts.spendLimit);
    return { kind: 'blocked', blockerKind: 'environment', summary };
  }
  // The session it resumes is gone: the next attempt starts a fresh one. After the limits, which
  // a fresh attempt would meet too (ADR 0117).
  if (facts.unresumed !== undefined) {
    return failed(true, `claude could not resume the session: ${facts.unresumed}`);
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
  // A fresh attempt would meet the same budget; one that resumes the session starts with the work
  // done, so the overrun is retryable when the session can be resumed (ADR 0047, ADR 0175).
  if (maxTurns !== undefined && turns > maxTurns) {
    const reason = `budget exceeded: ${turns} turns, maxTurns is ${maxTurns}`;
    return limits.resumable === true && facts.sessionStarted === true
      ? { kind: 'failed', retryable: true, reason, overran: 'turns' }
      : failed(false, reason);
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
      // The engine reads the verdict; the Taster does not choose to block (ADR 0161).
      if (
        limits.blocking === true &&
        'verdict' in frontmatter &&
        frontmatter.verdict === 'changes'
      ) {
        const summary = `the Taster asks for changes: ${frontmatter.summary}`;
        // The findings stay open on the Stuck reason when the route has no rounds left (ADR 0192).
        const findings = tastingOf(frontmatter)?.findings ?? [];
        return { kind: 'blocked', blockerKind: 'findings', summary, findings };
      }
      if (limits.commitsSince === undefined) return { kind: 'succeeded', output: frontmatter };
      return doneWithCommits(facts.commits, limits.commitsSince, frontmatter);
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

/** The findings a failed scan names; it counts the rest, as the refused push does (ADR 0079). */
const NAMED_FINDINGS = 3;

/**
 * A commit as a failed scan names it: no state knows a failed attempt's commits, so a full hash
 * would read as a key, and the status comment would leave the whole reason out (ADR 0088).
 */
const SHORT_COMMIT = 12;

/**
 * A succeeded attempt of a brewer that produces commits, once the commits after `since` were
 * scanned for secrets (ADR 0187): a finding fails it retryably, naming each commit, place and
 * kind, never the matched text (ADR 0088).
 */
export function scannedEnding(ending: Ending, scanned: CommitsScanned, since: string): Ending {
  if (ending.kind !== 'succeeded') return ending;
  switch (scanned.kind) {
    case 'scanned': {
      const { findings } = scanned;
      if (findings.length === 0) return ending;
      // The place comes last, so a file named `token` never reads as an assignment (ADR 0088).
      const named = findings
        .slice(0, NAMED_FINDINGS)
        .map(
          ({ commit, place, kind }) =>
            `commit ${commit.slice(0, SHORT_COMMIT)}, ${kind} in ${place}`,
        );
      const more = findings.length - named.length;
      const places = [...named, ...(more > 0 ? [`and ${more} more`] : [])].join('; ');
      // The mark tells its retry's plan why it runs.
      const reason = `the attempt's commits hold what looks like a secret, or what the scan cannot read (ADR 0187): ${places}`;
      return { kind: 'failed', retryable: true, reason, secrets: true };
    }
    case 'unscanned': {
      const summary = `the commits since ${since.slice(0, 7)} were not scanned for secrets: ${scanned.reason}`;
      return { kind: 'blocked', blockerKind: 'environment', summary };
    }
    default: {
      const unhandled: never = scanned;
      throw new Error(`Unhandled scan ${JSON.stringify(unhandled)}`);
    }
  }
}
