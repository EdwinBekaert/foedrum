// What a batch's commits would publish that looks like a secret (ADR 0079), the pure core: the
// messages and the added lines that `git log` shows for them, read with findSecrets. A finding
// names the commit, the file (or the message) and the kind, never the text it matched.

import type { IsCommit } from './secrets.ts';

export interface ScanFinding {
  commit: string;
  /** The file's path as git shows it, `message`, or why neither can be named. */
  place: string;
  kind: string;
}

/** The place of a finding in a commit's message. */
export const MESSAGE = 'message';

/** The findings in the output of `git log --format=%x00%H%n%B`: one commit after each NUL. */
export const scanMessages = (_log: string, _isCommit: IsCommit): ScanFinding[] => {
  throw new Error('not implemented');
};

/**
 * The findings in the output of `git log --format=%x00%H --patch --unified=0` with the prefixes
 * `a/` and `b/`: the added lines of each file, and every binary file, which the scan cannot read.
 */
export const scanPatches = (_log: string, _isCommit: IsCommit): ScanFinding[] => {
  throw new Error('not implemented');
};

/** Every 40-character hexadecimal word of `text`: what may be a commit rather than a key. */
export const commitCandidates = (_text: string): string[] => {
  throw new Error('not implemented');
};
