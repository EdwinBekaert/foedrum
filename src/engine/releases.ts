// The releases of the repositories a `release` blocker waits on (ADR 0216, ADR 0223): each intake
// pass reads the latest release of every repository with a merged, unreleased `release` blocker,
// and records it once it holds a merge of every blocker that waits on it, so the sub-orders they
// block start.

import type { CommandLog } from './command-log.ts';

/** A repository's latest release as the code host has it: GitHub's latest release, else tag. */
export interface LatestRelease {
  /** Its tag's name: the version a record names. */
  version: string;
  /** When it was published, or for a tag its commit's date, in ISO 8601. */
  published: string;
}

/** What the pass reads of a repository's releases; GitHub's is `githubReleaseReader`. */
export interface ReleaseReader {
  /** The latest release of `repo`, or undefined when it has none. */
  latest(repo: string, signal?: AbortSignal): Promise<LatestRelease | undefined>;
  /** Whether `release` of `repo` holds the merge of the pull request at `pullRequest`. */
  holds(
    repo: string,
    release: LatestRelease,
    pullRequest: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface ReleaseReadOptions {
  log: CommandLog;
  reader: ReleaseReader;
  clock: () => Date;
  /** A release it recorded. */
  released: (repo: string, version: string) => void;
  /** What it could not do: a release it could not read, a refused record. */
  failed: (what: string, error: unknown) => void;
}

/** One pass: reads the latest release of each repository a blocker waits on, and records it. */
export const recordReleases = async (
  _options: ReleaseReadOptions,
  _signal: AbortSignal,
): Promise<void> => {
  throw new Error('not implemented');
};
