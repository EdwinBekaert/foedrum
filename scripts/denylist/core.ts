// The personal denylist of the local gate, the pure core (ADR 0114, ADR 0021): the list's text,
// the words of a line, the matching, and the places in git's output of what a push sends. A place
// names a commit and a file, line or field, never the word that matched.

const LETTERS_AND_DIGITS = /[\p{L}\p{N}]+/gu;
// Inside a run of letters and digits: lower to upper (fooBar), the last capital of an acronym
// before a word (HTTPServer), and between letters and digits (v2Api).
const INNER_BOUNDARY =
  /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

// Compatibility form, so a full-width or styled letter reads as the plain one.
const plain = (text: string): string => text.normalize('NFKC');

/** The entries of a list file's text: letters and digits only, lowercased. */
export const parseDenylist = (text: string): string[] =>
  plain(text.replace(/^﻿/, ''))
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => (line.match(LETTERS_AND_DIGITS) ?? []).join('').toLowerCase())
    .filter((entry) => entry !== '');

/** The words of a line, lowercased, split at camelCase and between letters and digits. */
export const wordsOf = (line: string): string[] =>
  (plain(line).match(LETTERS_AND_DIGITS) ?? []).flatMap((run) =>
    run.split(INNER_BOUNDARY).map((word) => word.toLowerCase()),
  );

// Whether a line holds an entry: one of its words, or several in a row joined together.
const matcher = (list: readonly string[]): ((line: string) => boolean) => {
  const entries = new Set(list);
  const longest = Math.max(0, ...list.map((entry) => entry.length));
  return (line) => {
    const words = wordsOf(line);
    for (let start = 0; start < words.length; start++) {
      let joined = '';
      for (let end = start; end < words.length && joined.length < longest; end++) {
        joined += words[end];
        if (entries.has(joined)) return true;
      }
    }
    return false;
  };
};

/** The 1-based numbers of the lines of `text` that hold an entry of `list`. */
export const deniedLines = (text: string, list: readonly string[]): number[] => {
  if (list.length === 0) return [];
  const holds = matcher(list);
  return text.split('\n').flatMap((line, i) => (holds(line) ? [i + 1] : []));
};

const short = (commit: string): string => `commit ${commit.slice(0, 7)}`;

/** The format of the `git log` whose output `scanMessages` reads. */
export const MESSAGE_FORMAT = '%x00%H%n%an%n%ae%n%cn%n%ce%n%B';

/** The places in the output of `git log --format=<MESSAGE_FORMAT>` that hold an entry. */
export const scanMessages = (log: string, list: readonly string[]): string[] => {
  const holds = matcher(list);
  return log
    .split('\0')
    .slice(1)
    .flatMap((chunk) => {
      const [commit = '', authorName = '', authorEmail = '', name = '', email = '', ...message] =
        chunk.split('\n');
      const where = short(commit);
      return [
        ...(holds(authorName) || holds(authorEmail) ? [`${where} author`] : []),
        ...(holds(name) || holds(email) ? [`${where} committer`] : []),
        ...deniedLines(message.join('\n'), list).map((line) => `${where} message line ${line}`),
      ];
    });
};

/** The place of a file whose path would itself say the word. */
const DENIED_PATH = 'a file whose path holds a denied word';

// The path of `diff --git a/<path> b/<path>`, quoted as git quotes it: renames are off, so both
// halves name the same file and the line splits in the middle; or of a merge's `diff --cc <path>`.
const pathOf = (header: string): string => {
  if (header.startsWith('diff --cc ')) return header.slice('diff --cc '.length);
  const both = header.slice('diff --git '.length);
  const old = both.slice(0, (both.length - 1) / 2);
  return old.startsWith('"') ? `"${old.slice(3)}` : old.slice(2);
};

// A hunk header, `@@ -a,b +c,d @@`, or a merge's with one `-` range per parent and one more `@`.
const HUNK = /^(@@+) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1/;

/**
 * The places in the output of `git log --format=%x00%H --patch --unified=0` with the prefixes
 * `a/` and `b/`, merges as combined diffs: the added lines of each file, and its path.
 * The lines of each hunk are counted from its header, for each parent and the result apart, so a
 * line is never read as a header, nor a header as part of a hunk.
 */
export const scanPatches = (log: string, list: readonly string[]): string[] => {
  const holds = matcher(list);
  const places = new Set<string>();
  let commit = '';
  let file = '';
  // A path that holds a word is a place once the file turns out not to be deleted.
  let pathHolds = false;
  const placePath = (): void => {
    if (pathHolds) places.add(`${short(commit)} ${DENIED_PATH}`);
    pathHolds = false;
  };
  // The lines still to come in the hunk, for each parent and for the result.
  let parentsLeft: number[] = [];
  let resultLeft = 0;
  let line = 0;
  for (const stored of log.split('\n')) {
    const text = stored.endsWith('\r') ? stored.slice(0, -1) : stored;
    if (resultLeft > 0 || parentsLeft.some((left) => left > 0)) {
      // `\ No newline at end of file` belongs to the line before it.
      if (text.startsWith('\\')) continue;
      const columns = text.slice(0, parentsLeft.length);
      const removed = columns.includes('-');
      parentsLeft = parentsLeft.map((left, i) =>
        (removed ? columns[i] === '-' : columns[i] !== '+') ? left - 1 : left,
      );
      if (removed) continue;
      resultLeft -= 1;
      line += 1;
      if (columns.includes('+') && holds(text.slice(parentsLeft.length))) {
        const at = file === DENIED_PATH ? `${DENIED_PATH}, line ` : `${file}:`;
        places.add(`${short(commit)} ${at}${line}`);
      }
    } else if (text.startsWith('\0')) {
      placePath();
      commit = text.slice(1).trim();
      file = '';
    } else if (text.startsWith('diff --git ') || text.startsWith('diff --cc ')) {
      placePath();
      const path = pathOf(text);
      pathHolds = holds(path);
      file = pathHolds ? DENIED_PATH : path;
    } else if (text.startsWith('deleted file mode ')) {
      // A deleted file's path is not in what the commit sends; the remote has it.
      pathHolds = false;
    } else {
      const hunk = HUNK.exec(text);
      if (hunk === null) continue;
      placePath();
      const ranges = (hunk[2] ?? '').trim().split(' ');
      parentsLeft = ranges.map((range) => Number(range.split(',')[1] ?? 1));
      resultLeft = Number(hunk[4] ?? 1);
      // A hunk that only removes starts after line c; one that adds starts at it.
      line = Number(hunk[3]) - 1;
    }
  }
  placePath();
  return [...places];
};

const SHOWN = 10;

/** The line that blocks `what`, naming the first ten places and counting the rest. */
export const deniedRefusal = (what: string, places: readonly string[]): string => {
  const more = places.length > SHOWN ? `; and ${places.length - SHOWN} more` : '';
  return `${what} is blocked: it would send a word on your denylist (ADR 0114), at ${places.slice(0, SHOWN).join('; ')}${more}. Take the word out and try again; the gate never says which word it found.`;
};
