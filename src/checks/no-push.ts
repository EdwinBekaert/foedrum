// The noPush guard, the pure core (ADR 0106): which refs of a target repository's remote changed
// between the reads before and after an attempt, leaving out the refs the engine wrote meanwhile
// and the ones only GitHub writes. push-guard.ts reads the remote.

/** A remote's refs, by name, each with its commit, as `ls-remote --refs` lists them. */
export type RemoteRefs = ReadonlyMap<string, string>;

/** A ref that changed: moved (both commits), created (`to` only) or deleted (`from` only). */
export interface ChangedRef {
  ref: string;
  from?: string;
  to?: string;
}

/** The refs `ls-remote --refs` printed, or why its output is not a listing. */
export function parseRemoteRefs(_listed: string): RemoteRefs | { error: string } {
  throw new Error('not implemented');
}

/**
 * The refs that changed from `before` to `after`, by name, but not those `engine` says the engine
 * wrote during the attempt, nor GitHub's own `refs/pull/`.
 */
export function changedRefs(
  _before: RemoteRefs,
  _after: RemoteRefs,
  _engine: (ref: string) => boolean,
): ChangedRef[] {
  throw new Error('not implemented');
}

/** Why the guard fails an attempt during which the remote of `repo` changed. */
export function noPushReason(_repo: string, _changed: readonly ChangedRef[]): string {
  throw new Error('not implemented');
}
