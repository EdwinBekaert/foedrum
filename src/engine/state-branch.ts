// The state branch's pure core (ADR 0011, ADR 0024): which file an event belongs to, how log
// files are read, merged and extended, what a step boundary is, and whether the engine may start.
// No I/O: the shell (state-branch-git.ts) gathers the facts and carries out the decisions.

import type { Event } from '../schemas/events.ts';
import type { PushedThrough } from '../schemas/store.ts';
import type { LoggedEvent, StoredEvent } from './event-store.ts';
import type { State } from './fold.ts';

/** The engine must stop: the state branch and this engine's store disagree (ADR 0024). */
export class StateBranchStopError extends Error {
  override readonly name = 'StateBranchStopError';
}

/** A file on the state branch, by its path with forward slashes, and its text. */
export interface BranchFile {
  path: string;
  text: string;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/** The log file an event belongs to: its batch's `events.jsonl`, or the top-level one. */
export const logPathOf = (_event: Event): string => notImplemented();

/** Where the out doc of an attempt goes: next to its batch's `events.jsonl`. */
export const outDocPath = (_attempt: {
  batchId: string;
  stepId: string;
  attempt: number;
}): string => notImplemented();

/** Whether `path` is a log file: `events.jsonl` or `batches/<batchId>/events.jsonl`. */
export const isLogPath = (_path: string): boolean => notImplemented();

/** Reads one log file; throws `StateBranchStopError` naming the file and line of a bad line. */
export const parseLog = (_file: BranchFile): LoggedEvent[] => notImplemented();

/**
 * Merges every log file by id. Throws `StateBranchStopError` for a bad line, a repeated id, or
 * an event in a file it does not belong to.
 */
export const mergeLogs = (_files: readonly BranchFile[]): LoggedEvent[] => notImplemented();

/**
 * The new text of every log file the pending events go to. `current` holds the files as they are
 * in the worktree (missing when absent). Lines after `pushedThrough` that a crashed flush left
 * behind are replaced; one that differs from the pending event with its id means another engine
 * wrote it, and throws `StateBranchStopError`.
 */
export const planFlush = (
  _current: ReadonlyMap<string, string | undefined>,
  _pending: readonly StoredEvent[],
  _pushedThrough: number,
): BranchFile[] => notImplemented();

/** The commit message of a flush. */
export const commitMessage = (_pending: readonly StoredEvent[]): string => notImplemented();

/**
 * The branch's events after the local ones, once every local event is checked to be on the
 * branch with the same id and content; throws `StateBranchStopError` when one is not.
 */
export const planCatchUp = (
  _branch: readonly LoggedEvent[],
  _local: readonly StoredEvent[],
): LoggedEvent[] => notImplemented();

/**
 * Whether appending `event` (which took the state from `before` to `after`) ends a step: it is
 * `step.finished`, or it changes a batch's lane kind (ADR 0024).
 */
export const isStepBoundary = (_event: Event, _before: State, _after: State): boolean =>
  notImplemented();

/** What the engine knows at start-up. */
export interface StartFacts {
  /** The remote branch, for messages, such as `origin/foedrum/state`. */
  branch: string;
  lastEventId: number;
  pushed: PushedThrough | undefined;
  /** The state worktree's commit; undefined before its first commit. */
  localHead: string | undefined;
  /** The remote branch's commit; undefined when the branch does not exist. */
  remoteHead: string | undefined;
  /** Whether the marker's commit is the remote head or one of its ancestors. */
  pushedReachesRemote: boolean;
}

export type StartDecision =
  | { kind: 'ready' }
  /** Push what is not on the branch yet. */
  | { kind: 'flush' }
  /** Append the branch's events after the local ones (the database is missing or behind). */
  | { kind: 'restore' }
  | { kind: 'stop'; reason: string };

export const decideStart = (_facts: StartFacts): StartDecision => notImplemented();

export type PushOutcome = 'pushed' | 'rejected' | 'failed';

/** Reads `git push --porcelain`: rejected means the remote moved (non-fast-forward). */
export const classifyPush = (_result: { code: number | null; stdout: string }): PushOutcome =>
  notImplemented();
