// The `touches` check of a plan (ADR 0233): after a plan's `done`, every path a sub-order touches
// that it does not mark new must exist in its repository at the commit the plan was written
// against. Git runs only through the injected `ReadPaths`, so no model and no fold is involved.

import { planOf } from '../schemas/plan.ts';
import type { Ending } from './decide.ts';
import { sameRepo } from './task-tree.ts';

/**
 * A repository of the Brewery, its clone, and the commit a plan's paths in it are checked at, or
 * why that commit could not be read: its base could not be fetched (ADR 0233).
 */
export type PlanRepository = { repo: string; clone: string } & (
  | { commit: string }
  | { unread: string }
);

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

/** The places a failed check names; it counts the rest, as the secret scan does (ADR 0187). */
const NAMED = 3;
/** A commit as a failed check names it, as the secret scan does (ADR 0187). */
const SHORT_COMMIT = 12;

const listed = (places: readonly string[]): string => {
  const more = places.length - NAMED;
  return [...places.slice(0, NAMED), ...(more > 0 ? [`and ${more} more`] : [])].join('; ');
};

/**
 * `ending`, once the paths of a succeeded plan were read in `repositories` (ADR 0233): a
 * repository the Brewery does not list, or a path not marked new that does not exist, fails it
 * retryably; a read that fails blocks it on its environment. Any other ending as it is.
 */
export async function touchesChecked(
  read: ReadPaths,
  ending: Ending,
  repositories: readonly PlanRepository[] | undefined,
  signal?: AbortSignal,
): Promise<Ending> {
  if (ending.kind !== 'succeeded' || repositories === undefined) return ending;
  const plan = planOf(ending.output);
  if (plan === undefined) return ending;
  const unknown: string[] = [];
  // The paths to read in each repository, in the order the plan names them, each once.
  const toRead = new Map<PlanRepository, { id: string; path: string }[]>();
  for (const { id, repo, touches } of plan.subOrders) {
    const repository = repositories.find((each) => sameRepo(each.repo, repo));
    if (repository === undefined) {
      unknown.push(`sub-order ${id}, ${repo}`);
      continue;
    }
    const paths = toRead.get(repository) ?? [];
    for (const touch of touches) if (touch.new !== true) paths.push({ id, path: touch.path });
    toRead.set(repository, paths);
  }
  if (unknown.length > 0) {
    const reason = `the plan names repositories the Brewery does not list (ADR 0233): ${listed(unknown)}`;
    return { kind: 'failed', retryable: true, reason };
  }
  const missing: string[] = [];
  for (const [repository, touched] of toRead) {
    if (touched.length === 0) continue;
    const { repo, clone, commit } = repository;
    const paths = [...new Set(touched.map(({ path }) => path))];
    const found = await read(clone, commit, paths, signal).catch(
      (error: unknown): PathsRead => ({
        kind: 'unread',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    if (found.kind === 'unread') {
      const summary = `the plan's paths in ${repo} at ${commit.slice(0, 7)} were not read: ${found.reason}`;
      return { kind: 'blocked', blockerKind: 'environment', summary };
    }
    for (const { id, path } of touched) {
      if (found.present.has(path)) continue;
      missing.push(`sub-order ${id}, ${path} in ${repo} at ${commit.slice(0, SHORT_COMMIT)}`);
    }
  }
  if (missing.length === 0) return ending;
  const reason = `the plan touches paths that do not exist; mark a path new: true when its sub-order creates it (ADR 0233): ${listed(missing)}`;
  return { kind: 'failed', retryable: true, reason };
}
