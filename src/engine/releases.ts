// The releases of the repositories a `release` blocker waits on (ADR 0216, ADR 0223): each intake
// pass reads the latest release of every repository with a merged, unreleased `release` blocker,
// and records it once it holds a merge of every blocker that waits on it, so the sub-orders they
// block start.

import type { CommandLog } from './command-log.ts';
import { releaseWaits } from './ready-set.ts';

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

/** Whether the fold holds `version` of `repo`, in any case. */
const recorded = (log: CommandLog, repo: string, version: string): boolean =>
  log
    .state()
    .releases.some(
      (release) => release.repo.toLowerCase() === repo.toLowerCase() && release.version === version,
    );

/**
 * One pass: reads the latest release of each repository a blocker waits on, and records it when
 * it holds a merge of every blocker waiting on it (ADR 0223).
 */
export const recordReleases = async (
  options: ReleaseReadOptions,
  signal: AbortSignal,
): Promise<void> => {
  const { log, reader, clock, released, failed } = options;
  // The waits as the log has them at the start: a release recorded here ends its own.
  for (const { repo, blockers } of releaseWaits(log.state())) {
    if (signal.aborted) return;
    let holdsAll = true;
    let latest: LatestRelease | undefined;
    try {
      latest = await reader.latest(repo, signal);
      if (latest === undefined || recorded(log, repo, latest.version)) continue;
      for (const merged of blockers) {
        let held = false;
        for (const pullRequest of merged) {
          held = await reader.holds(repo, latest, pullRequest, signal);
          if (held) break;
        }
        // A release recorded counts for every blocker merged before it: it must hold them all.
        if (!held) {
          holdsAll = false;
          break;
        }
      }
    } catch (error) {
      failed(`reading the latest release of ${repo}`, error);
      continue;
    }
    // A pass given up at its deadline records nothing more.
    if (signal.aborted) return;
    if (!holdsAll) continue;
    const { version } = latest;
    const event = {
      type: 'release.observed',
      repo,
      package: repo.split('/').at(-1) ?? repo,
      version,
    } as const;
    const decision = log.issue({ kind: 'record', event }, clock());
    if (decision.kind === 'accepted') released(repo, version);
    else failed(`recording the release ${version} of ${repo}`, new Error(decision.reason));
  }
};
