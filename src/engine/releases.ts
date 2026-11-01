// The releases of the repositories a `release` blocker waits on (ADR 0216, ADR 0223): each intake
// pass reads the latest release of every repository with a merged, unreleased `release` blocker,
// and records it once it holds a merge of every blocker that waits on it, so the sub-orders they
// block start.

import { findSecrets } from '../formats/secrets.ts';
import { MAX_RELEASE_NOTES_LENGTH } from '../schemas/events.ts';
import { releaseRecorded } from './admit.ts';
import type { CommandLog } from './command-log.ts';
import { releaseWaits } from './ready-set.ts';

/**
 * `notes` cut to at most `most` characters, ending in an ellipsis, after their last whole line, so
 * no line is cut in the middle; a first line too long is cut on a code point.
 */
const cut = (notes: string, most: number): string => {
  if (notes.length <= most) return notes;
  const head = notes.slice(0, most - 1);
  const end = head.lastIndexOf('\n');
  if (end >= 0) return `${head.slice(0, end + 1)}…`;
  const last = head.charCodeAt(head.length - 1);
  const pairStarts = last >= 0xd800 && last <= 0xdbff;
  return `${pairStarts ? head.slice(0, -1) : head}…`;
};

/**
 * Release notes as a record keeps them (ADR 0291): with LF line ends, every line that looks like a
 * secret left out and a last line that says how many were, the rest cut to what the record keeps.
 * The record goes to the state branch, and the input reads it as it is.
 */
const recordedNotes = (notes: string): string => {
  const all = notes.split(/\r?\n/);
  const kept = all.filter((line) => findSecrets(line, () => false).length === 0);
  const left = all.length - kept.length;
  if (left === 0) return cut(kept.join('\n'), MAX_RELEASE_NOTES_LENGTH);
  const lines = left === 1 ? '1 line' : `${left} lines`;
  const count = `(${lines} of the notes left out: they looked like secrets)`;
  return `${cut(kept.join('\n'), MAX_RELEASE_NOTES_LENGTH - count.length - 2)}\n\n${count}`;
};

/** A repository's latest release as the code host has it: GitHub's latest release, else tag. */
export interface LatestRelease {
  /** Its tag's name: the version a record names. */
  version: string;
  /** When it was published, or for a tag its commit's date, in ISO 8601. */
  published: string;
  /** A tag with no release: its date is its commit's, set where it was made (ADR 0223). */
  tag?: boolean;
  /** A release's web page and its notes, as the code host has them; a tag has neither (ADR 0291). */
  url?: string;
  notes?: string;
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
      if (latest === undefined || releaseRecorded(log.state(), repo, latest.version)) continue;
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
    const { version, url, notes } = latest;
    const event = {
      type: 'release.observed',
      repo,
      package: repo.split('/').at(-1) ?? repo,
      version,
      ...(url === undefined ? {} : { url }),
      ...(notes === undefined ? {} : { notes: recordedNotes(notes) }),
    } as const;
    const decision = log.issue({ kind: 'record', event }, clock());
    if (decision.kind === 'accepted') released(repo, version);
    else failed(`recording the release ${version} of ${repo}`, new Error(decision.reason));
  }
};
