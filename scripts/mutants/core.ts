// Decides whether a Brett mutant is valid and what it does to its file (ADR 0021, issue #43).
// Brett answers with structured edits instead of patches, so no hand-written hunk header can
// make a mutant fail to apply: each mutant replaces one existing line of a file under src/ or
// scripts/, where the gate, the check and the review tooling live (ADR 0040).

export interface Mutant {
  file: string;
  line: number;
  original: string;
  replacement: string;
}

export type MutantCheck = { ok: true; mutant: Mutant } | { ok: false; reason: string };

// `line` is the line the edit replaced, which may differ from the mutant's line number.
export type MutantEdit =
  | { ok: true; content: string; line: number }
  | { ok: false; reason: string };

// The folders whose files a mutant may edit.
const MUTABLE_FOLDERS = ['src', 'scripts'];

// A relative path with forward slashes, with no empty, `.` or `..` segment, and no backslash,
// drive colon, control character or line separator. scripts/citations/core.ts has its own copy:
// the review skill may take that file from a pull request and this one from its base.
const isPlainPath = (file: string): boolean =>
  file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
  !/[\\:\p{Cc}\p{Zl}\p{Zp}]/u.test(file);

// A plain path to a file under src/ or scripts/.
const isMutable = (file: string): boolean => {
  const [folder, ...rest] = file.split('/');
  return isPlainPath(file) && rest.length > 0 && MUTABLE_FOLDERS.includes(folder ?? '');
};

const strings = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;
const comments = /\/\/.*$|\/\*.*?\*\//g;
// Only the characters of a number literal (hex, octal, binary, separators, a fraction, an
// exponent, bigint), so a property name after it (`1..constructor`) is still a word.
const numbers =
  /(?<![\p{ID_Continue}$])(?:0[xob][\da-f_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?n?|\.\d[\d_]*(?:e[+-]?\d+)?)/giu;
const words = /[\p{ID_Start}$_][\p{ID_Continue}$]*/gu;

// The line with whitespace only where it separates two words, so a change of whitespace alone
// (`a+b` for `a + b`) is no change.
const squash = (code: string): string =>
  code
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/ ?([^\p{ID_Continue}$ ]) ?/gu, '$1');

// The strings and the words (identifiers, property names, keywords) in a line of code, outside
// comments, so a mutant cannot turn commented-out code on; the boolean literals count as
// literals, which a mutant may change.
const names = (code: string): Set<string> => {
  const quoted = code.match(strings) ?? [];
  const rest = code.replace(strings, ' ').replace(comments, ' ').replace(numbers, ' ');
  const bare = (rest.match(words) ?? []).filter((word) => word !== 'true' && word !== 'false');
  return new Set([...quoted, ...bare]);
};

// The files a change leaves at its head, from `git diff --name-status` (files.txt of the review).
export const touchedFiles = (_nameStatus: string): string[] => {
  throw new Error('not implemented');
};

// Checks one entry of Brett's answer on its own: its shape, its path and the allowlist.
export const parseMutant = (value: unknown, _touched?: readonly string[]): MutantCheck => {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'the entry is not an object' };
  }
  const { file, line, original, replacement } = value as Record<string, unknown>;
  for (const [field, text] of Object.entries({ file, original, replacement })) {
    if (typeof text !== 'string') return { ok: false, reason: `"${field}" is not a string` };
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return { ok: false, reason: '"line" is not a line number' };
  }
  const mutant = { file, line, original, replacement } as Mutant;
  if (!isMutable(mutant.file)) {
    // The name is model output; quoted, its control characters cannot forge an output line.
    return {
      ok: false,
      reason: `${JSON.stringify(mutant.file)} is not a file under src/ or scripts/`,
    };
  }
  if (/[\r\n\p{Zl}\p{Zp}]/u.test(mutant.replacement)) {
    return { ok: false, reason: 'the replacement is more than one line' };
  }
  if (squash(mutant.replacement) === squash(mutant.original)) {
    return { ok: false, reason: 'the replacement changes nothing' };
  }
  // A mutant may only change operators and number or boolean literals, or delete or reorder
  // existing code: a small bug, never a new capability.
  const known = names(mutant.original);
  const added = [...names(mutant.replacement)].filter((name) => !known.has(name));
  if (added.length > 0) {
    return { ok: false, reason: `the replacement adds ${added.join(', ')}` };
  }
  return { ok: true, mutant };
};

// Written by its code point: a literal one is invisible in the source.
const byteOrderMark = String.fromCodePoint(0xfeff);

// Applies a parsed mutant to the content of its file (undefined when the file does not exist).
// The line is the one whose text, ignoring leading and trailing whitespace, is the original:
// the mutant's line number when that line matches, otherwise the only line that does.
// Reviewers' line numbers are often off, and the text is what makes the edit exact.
export const editFile = (mutant: Mutant, content: string | undefined): MutantEdit => {
  if (content === undefined) return { ok: false, reason: `${mutant.file} does not exist` };
  // Each line keeps its own ending; a final newline does not start another line.
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const original = mutant.original.trim();
  const matching = lines.flatMap((text, index) => (text.trim() === original ? [index + 1] : []));
  const [only] = matching;
  const line = matching.includes(mutant.line)
    ? mutant.line
    : matching.length === 1
      ? only
      : undefined;
  if (line === undefined) {
    const reason =
      matching.length === 0
        ? `no line of ${mutant.file} is the original`
        : `the original is on lines ${matching.join(', ')} of ${mutant.file}, not on line ${mutant.line}`;
    return { ok: false, reason };
  }
  const at = lines[line - 1] ?? '';
  // The indentation (after a byte order mark) and the line ending stay as they are.
  const bom = at.startsWith(byteOrderMark) ? byteOrderMark : '';
  const indent = bom + (/^[ \t]*/.exec(at.slice(bom.length))?.[0] ?? '');
  const ending = /\r?\n$/.exec(at)?.[0] ?? '';
  const replacement = mutant.replacement.trim();

  lines[line - 1] = replacement === '' ? bom : `${indent}${replacement}${ending}`;
  return { ok: true, content: lines.join(''), line };
};
