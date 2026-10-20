// What a batch's commits would publish that looks like a secret (ADR 0079), the pure core: the
// messages, the headers and the added lines that `git log` shows for them, read with findSecrets.
// A finding names the commit, the file (or the message, or the header) and the kind, never the
// text it matched.

import type { ScanFinding } from '../schemas/store.ts';
import { findSecrets, type IsCommit } from './secrets.ts';

/** The place of a finding in a commit's message. */
export const MESSAGE = 'message';

/** The place of a finding in a file whose path would itself say too much. */
const SECRET_PATH = 'a file whose path looks like a secret';

const BINARY = 'binary file';

// A commit's headers in `git log --format=raw`: the tree and parents are hashes the push needs,
// the author and committer are named by their header, and any other header by `header <name>`.
const COMMIT_LINE = /^commit ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/;
const UNREAD_HEADERS = new Set(['tree', 'parent']);
const PEOPLE = new Set(['author', 'committer']);
const SIGNATURES = new Set(['gpgsig', 'gpgsig-sha256']);
const HEADER_NAME = /^[a-z][a-z0-9-]*$/;
const SECRET_HEADER = 'a header';
const BASE64 = 'long base64 string';

// A package lock's integrity hashes (Subresource Integrity) look random and are not secret. In any
// other file such a prefix could disguise a key, so only a lock's are left out.
const INTEGRITY = /\bsha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}/g;
const LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const isLock = (path: string): boolean => LOCKS.has(path.split('/').at(-1) ?? '');

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

/**
 * The findings in the headers of each commit in the output of `git log --format=raw`: the author,
 * the committer, and every other header the push carries and `%B` does not show (a signature, an
 * encoding, a merged tag). The message, indented below them, is `scanMessages`' to read.
 */
export const scanHeaders = (log: string, isCommit: IsCommit): ScanFinding[] => {
  const found = collect();
  let commit = '';
  let inHeaders = false;
  const headers: { name: string; lines: string[] }[] = [];
  const flush = (): void => {
    for (const { name, lines } of headers) {
      if (UNREAD_HEADERS.has(name)) continue;
      const place = PEOPLE.has(name)
        ? name
        : HEADER_NAME.test(name)
          ? `header ${name}`
          : SECRET_HEADER;
      for (const { kind } of findSecrets(lines.join('\n'), isCommit)) {
        // A signature's armour is base64 by nature; a token in it is still found by its own kind.
        if (SIGNATURES.has(name) && kind === BASE64) continue;
        found.add({ commit, place, kind });
      }
    }
    headers.length = 0;
  };
  for (const stored of log.split('\n')) {
    // git ends the headers only at an empty line, so a line that is only a CR is still a header.
    const line = stored.endsWith('\r') ? stored.slice(0, -1) : stored;
    const start = COMMIT_LINE.exec(line);
    if (start !== null) {
      flush();
      commit = start[1] ?? '';
      inHeaders = true;
    } else if (!inHeaders) {
      // The message, indented, is scanMessages' to read.
    } else if (stored === '') {
      flush();
      inHeaders = false;
    } else if (line.startsWith(' ')) {
      headers.at(-1)?.lines.push(line.slice(1));
    } else {
      headers.push({ name: line.split(' ', 1)[0] ?? '', lines: [line] });
    }
  }
  flush();
  return found.list();
};

/** The commits of the output of `git log --format=%x00%H%n%B`, in order. */
export const messageCommits = (log: string): string[] =>
  log
    .split('\0')
    .slice(1)
    .map((chunk) => chunk.split('\n', 1)[0] ?? '');

/** The commits of the output of `git log --format=raw`, in order. */
export const rawCommits = (log: string): string[] =>
  log.split('\n').flatMap((line) => COMMIT_LINE.exec(line.replace(/\r$/, ''))?.[1] ?? []);

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
 * The lines of each hunk are counted from its header, old and new apart, as a context line counts
 * on both sides: an added line is never read as a header, nor a header as part of a hunk.
 */
export const scanPatches = (log: string, isCommit: IsCommit): ScanFinding[] => {
  const found = collect();
  let commit = '';
  let path = '';
  let added: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  let deleted = false;
  // A path is published too: it is read like a line, and a finding never names one that matches.
  const placeOf = (): string => (findSecrets(path, isCommit).length === 0 ? path : SECRET_PATH);
  const flush = (): void => {
    if (path === '') return;
    const inPath = findSecrets(path, isCommit);
    const place = inPath.length === 0 ? path : SECRET_PATH;
    for (const { kind } of inPath) found.add({ commit, place, kind });
    const joined = added.join('\n');
    const text = isLock(path) ? joined.replace(INTEGRITY, '') : joined;
    for (const { kind } of findSecrets(text, isCommit)) found.add({ commit, place, kind });
    added = [];
  };
  for (const line of log.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      // `\ No newline at end of file` belongs to the line before it.
      if (line.startsWith('\\')) continue;
      if (line.startsWith('+')) {
        added.push(line.slice(1));
        newLeft -= 1;
      } else if (line.startsWith('-')) {
        oldLeft -= 1;
      } else {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith('\0')) {
      flush();
      commit = line.slice(1).trim();
      path = '';
    } else if (line.startsWith('diff --git ')) {
      flush();
      path = pathOf(line);
      deleted = false;
    } else if (line.startsWith('deleted file mode ')) {
      deleted = true;
    } else if (line.startsWith('Binary files ')) {
      // A binary file the commit deletes publishes nothing: the base has it. The header says so,
      // never the path, which could end in ` and /dev/null`.
      if (!deleted) found.add({ commit, place: placeOf(), kind: BINARY });
    } else {
      const hunk = HUNK.exec(line);
      if (hunk !== null) {
        oldLeft = Number(hunk[1] ?? 1);
        newLeft = Number(hunk[2] ?? 1);
      }
    }
  }
  flush();
  return found.list();
};

/** Every 40-character hexadecimal word of `text`: what may be a commit rather than a key. */
export const commitCandidates = (text: string): string[] => [
  ...new Set(text.match(/\b[0-9a-f]{40}\b/gi) ?? []),
];
