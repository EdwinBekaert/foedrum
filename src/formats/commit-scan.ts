// What a batch's commits would publish that looks like a secret (ADR 0079), the pure core: the
// messages and the added lines that `git log` shows for them, read with findSecrets. A finding
// names the commit, the file (or the message) and the kind, never the text it matched.

import { findSecrets, type IsCommit } from './secrets.ts';

export interface ScanFinding {
  commit: string;
  /** The file's path as git shows it, `message`, or why neither can be named. */
  place: string;
  kind: string;
}

/** The place of a finding in a commit's message. */
export const MESSAGE = 'message';

/** The place of a finding in a file whose path would itself say too much. */
const SECRET_PATH = 'a file whose path looks like a secret';

const BINARY = 'binary file';

// A package lock's integrity hashes (Subresource Integrity) look random and are not secret.
const INTEGRITY = /\bsha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}/g;

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** The findings, one per commit, place and kind, in the order they were found. */
const collect = () => {
  const found = new Map<string, ScanFinding>();
  return {
    add: (finding: ScanFinding): void => {
      found.set(JSON.stringify(finding), finding);
    },
    list: (): ScanFinding[] => [...found.values()],
  };
};

/** The findings in the output of `git log --format=%x00%H%n%B`: one commit after each NUL. */
export const scanMessages = (log: string, isCommit: IsCommit): ScanFinding[] => {
  const found = collect();
  for (const chunk of log.split('\0').slice(1)) {
    const newline = chunk.indexOf('\n');
    const commit = newline === -1 ? chunk : chunk.slice(0, newline);
    const message = newline === -1 ? '' : chunk.slice(newline + 1);
    for (const { kind } of findSecrets(message, isCommit)) {
      found.add({ commit, place: MESSAGE, kind });
    }
  }
  return found.list();
};

// The path of `diff --git a/<path> b/<path>`, quoted as git quotes it: renames are off, so both
// halves name the same file and the line splits in the middle, spaces in the path or not.
const pathOf = (header: string): string => {
  const both = header.slice('diff --git '.length);
  const old = both.slice(0, (both.length - 1) / 2);
  return old.startsWith('"') ? `"${old.slice(3)}` : old.slice(2);
};

/**
 * The findings in the output of `git log --format=%x00%H --patch --unified=0` with the prefixes
 * `a/` and `b/`: the added lines of each file, and every binary file, which the scan cannot read.
 * The lines of each hunk are counted from its header, so an added line is never read as a header.
 */
export const scanPatches = (log: string, isCommit: IsCommit): ScanFinding[] => {
  const found = collect();
  let commit = '';
  let path = '';
  let added: string[] = [];
  let left = 0;
  // A path is published too: it is read like a line, and a finding never names one that matches.
  const placeOf = (): string => (findSecrets(path, isCommit).length === 0 ? path : SECRET_PATH);
  const flush = (): void => {
    if (path === '') return;
    const inPath = findSecrets(path, isCommit);
    const place = inPath.length === 0 ? path : SECRET_PATH;
    for (const { kind } of inPath) found.add({ commit, place, kind });
    const text = added.join('\n').replace(INTEGRITY, '');
    for (const { kind } of findSecrets(text, isCommit)) found.add({ commit, place, kind });
    added = [];
  };
  for (const line of log.split(/\r?\n/)) {
    if (left > 0) {
      // `\ No newline at end of file` belongs to the line before it.
      if (line.startsWith('\\')) continue;
      left -= 1;
      if (line.startsWith('+')) added.push(line.slice(1));
      continue;
    }
    if (line.startsWith('\0')) {
      flush();
      commit = line.slice(1).trim();
      path = '';
    } else if (line.startsWith('diff --git ')) {
      flush();
      path = pathOf(line);
    } else if (line.startsWith('Binary files ')) {
      found.add({ commit, place: placeOf(), kind: BINARY });
    } else {
      const hunk = HUNK.exec(line);
      if (hunk !== null) left = Number(hunk[1] ?? 1) + Number(hunk[2] ?? 1);
    }
  }
  flush();
  return found.list();
};

/** Every 40-character hexadecimal word of `text`: what may be a commit rather than a key. */
export const commitCandidates = (text: string): string[] => [
  ...new Set(text.match(/\b[0-9a-f]{40}\b/gi) ?? []),
];
