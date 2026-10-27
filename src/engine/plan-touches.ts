// The `touches` check of a plan (ADR 0233): after a plan's `done`, every path a sub-order touches
// that it does not mark new must exist in its repository at the commit the plan was written
// against. Git runs only through the injected `ReadPaths`, so no model and no fold is involved.

import type { Ending } from './decide.ts';

/** A repository of the Brewery, its clone, and the commit a plan's paths in it are checked at. */
export interface PlanRepository {
  repo: string;
  clone: string;
  commit: string;
}

/** The paths git found at a commit, or why it could not read them. */
export type PathsRead =
  | { kind: 'read'; present: ReadonlySet<string> }
  | { kind: 'unread'; reason: string };

/** Which of `paths` exist at `commit` in `clone`; never throws, git's failure is `unread`. */
export type ReadPaths = (
  clone: string,
  commit: string,
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<PathsRead>;

/**
 * `ending`, once the paths of a succeeded plan were read in `repositories` (ADR 0233): a
 * repository the Brewery does not list, or a path not marked new that does not exist, fails it
 * retryably; a read that fails blocks it on its environment. Any other ending as it is.
 */
export async function touchesChecked(
  _read: ReadPaths,
  _ending: Ending,
  _repositories: readonly PlanRepository[] | undefined,
  _signal?: AbortSignal,
): Promise<Ending> {
  throw new Error('not implemented');
}
