// The personal denylist of the local gate, the pure core (ADR 0114, ADR 0021): the list's text,
// the words of a line, the matching, and the places in git's output of what a push sends. A place
// names a commit and a file, line or field, never the word that matched.

/** The entries of a list file's text: letters and digits only, lowercased. */
export const parseDenylist = (_text: string): string[] => {
  throw new Error('not implemented');
};

/** The words of a line, lowercased, split at camelCase and between letters and digits. */
export const wordsOf = (_line: string): string[] => {
  throw new Error('not implemented');
};

/** The 1-based numbers of the lines of `text` that hold an entry of `list`. */
export const deniedLines = (_text: string, _list: readonly string[]): number[] => {
  throw new Error('not implemented');
};

/** The format of the `git log` whose output `scanMessages` reads. */
export const MESSAGE_FORMAT = '%x00%H%n%an%n%ae%n%cn%n%ce%n%B';

/** The places in the output of `git log --format=<MESSAGE_FORMAT>` that hold an entry. */
export const scanMessages = (_log: string, _list: readonly string[]): string[] => {
  throw new Error('not implemented');
};

/**
 * The places in the output of `git log --format=%x00%H --patch --unified=0` with the prefixes
 * `a/` and `b/`, merges as combined diffs: the added lines of each file, and its path.
 */
export const scanPatches = (_log: string, _list: readonly string[]): string[] => {
  throw new Error('not implemented');
};

/** The line that blocks `what`, naming the first ten places and counting the rest. */
export const deniedRefusal = (_what: string, _places: readonly string[]): string => {
  throw new Error('not implemented');
};
