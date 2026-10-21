// The noPush guard, the pure core (ADR 0106): which refs of a target repository's remote changed
// between the reads before and after an attempt, leaving out the refs the engine wrote meanwhile
// and the ones only GitHub writes. push-guard.ts reads the remote.

import { cut } from './red-proof.ts';

/** A remote's refs, by name, each with its commit, as `ls-remote --refs` lists them. */
export type RemoteRefs = ReadonlyMap<string, string>;

/** A ref that changed: moved (both commits), created (`to` only) or deleted (`from` only). */
export interface ChangedRef {
  ref: string;
  from?: string;
  to?: string;
}

// `<sha-1 or sha-256>\t<ref>`, as ls-remote prints each ref.
const LISTED = /^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/\S+)$/;
// GitHub writes these itself and refuses a push to them, so nobody's push moves them.
const GITHUB_OWN = 'refs/pull/';

/** The refs `ls-remote --refs` printed, or why its output is not a listing. */
export function parseRemoteRefs(listed: string): RemoteRefs | { error: string } {
  const refs = new Map<string, string>();
  for (const line of listed.split(/\r?\n/)) {
    if (line === '') continue;
    const match = LISTED.exec(line);
    const [, sha, ref] = match ?? [];
    if (sha === undefined || ref === undefined) {
      return { error: `git ls-remote printed a line that names no ref: ${cut(line)}` };
    }
    if (refs.has(ref)) return { error: `git ls-remote listed ${cut(ref)} twice` };
    refs.set(ref, sha);
  }
  return refs;
}

/**
 * The refs that changed from `before` to `after`, by name, but not those `engine` says the engine
 * wrote during the attempt, nor GitHub's own `refs/pull/`.
 */
export function changedRefs(
  before: RemoteRefs,
  after: RemoteRefs,
  engine: (ref: string) => boolean,
): ChangedRef[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.flatMap((ref): ChangedRef[] => {
    const from = before.get(ref);
    const to = after.get(ref);
    if (from === to || ref.startsWith(GITHUB_OWN) || engine(ref)) return [];
    return [{ ref, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }];
  });
}

const described = ({ ref, from, to }: ChangedRef): string => {
  const name = cut(ref);
  if (from === undefined) return `${name} was created at ${to}`;
  if (to === undefined) return `${name} was deleted at ${from}`;
  return `${name} moved from ${from} to ${to}`;
};

/** Why the guard fails an attempt during which the remote of `repo` changed. */
export function noPushReason(repo: string, changed: readonly ChangedRef[]): string {
  const [first] = changed;
  if (first === undefined) throw new Error('No ref changed');
  const more = changed.length > 1 ? ` (and ${changed.length - 1} more)` : '';
  return `the guard noPush: the remote of ${repo} changed during the attempt: ${described(first)}${more}`;
}
