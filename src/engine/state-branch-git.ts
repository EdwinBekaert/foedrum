// The state branch's shell (ADR 0011, ADR 0024): gathers facts from git and the store, and
// carries out what state-branch.ts decides. Git runs only through the injected `Git`.

import type { Git } from '../workspace/git.ts';
import type { EventStore } from './event-store.ts';
import type { StartDecision } from './state-branch.ts';

export interface StateBranchOptions {
  store: EventStore;
  git: Git;
  /** The Brewery clone. */
  clone: string;
  /** The state branch's own worktree, in the work root outside the clone (ADR 0012). */
  worktree: string;
  /** Default `origin`. */
  remote?: string;
  /** Default `foedrum/state`. */
  branch?: string;
}

export type FlushResult =
  | { kind: 'pushed'; through: number; commit: string }
  /** Nothing to push. */
  | { kind: 'unchanged' }
  /** Not pushed (no network, a remote hook); the marker stays and the next boundary retries. */
  | { kind: 'failed'; reason: string };

export interface StartResult {
  decision: StartDecision['kind'];
  flush?: FlushResult;
}

export interface StateBranch {
  /**
   * Opens the state worktree, checks that a commit can be made (and signed, when the clone
   * signs), and brings the store and the branch in line. Throws `StateBranchStopError` when the
   * engine must not run.
   */
  start(): Promise<StartResult>;
  /**
   * Writes the out doc of an attempt into the state worktree. Call it before appending the event
   * that refers to it, so both go into the same commit.
   */
  writeOutDoc(
    attempt: { batchId: string; stepId: string; attempt: number },
    text: string,
  ): Promise<void>;
  /**
   * Commits and pushes every event after the pushed-through marker; call it at every step
   * boundary. Throws `StateBranchStopError` when the push is rejected: another engine wrote.
   */
  flush(): Promise<FlushResult>;
}

export const openStateBranch = (_options: StateBranchOptions): StateBranch => {
  const notImplemented = (): never => {
    throw new Error('not implemented');
  };
  return { start: notImplemented, writeOutDoc: notImplemented, flush: notImplemented };
};
