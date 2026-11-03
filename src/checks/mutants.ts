// Whether a Brett mutant is valid and what it does to its file (ADR 0034, ADR 0040). Brett
// answers with structured edits instead of patches, so no hand-written hunk header can make a
// mutant fail to apply: each mutant replaces one existing line of a file. The review tooling
// (scripts/mutants/core.ts) imports these rules, and the review skill copies this file from a
// pull request's base beside it, so it imports nothing at run time.

import type { MutantEdit } from '../schemas/out-doc.ts';

/** A mutant's place and edit, of the out doc's shape (ADR 0034): one line, and its replacement. */
export type Mutant = Pick<MutantEdit, 'file' | 'line' | 'original' | 'replacement'>;

// `line` is the line the edit replaced, which may differ from the mutant's line number.
export type LineEdit = { ok: true; content: string; line: number } | { ok: false; reason: string };

// A relative path with forward slashes, with no empty, `.` or `..` segment, and no backslash,
// drive colon, control character or line separator. scripts/citations/core.ts has its own copy:
// the review skill may take that file from a pull request and this one from its base.
export const isPlainPath = (file: string): boolean =>
  file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
  !/[\\:\p{Cc}\p{Zl}\p{Zp}]/u.test(file);

export const strings = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;
export const comments = /\/\/.*$|\/\*.*?\*\//g;
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
// `//` and `/* */` comments when `stripped`, so a mutant cannot turn commented-out code on; the
// boolean literals count as literals, which a mutant may change.
const names = (code: string, stripped: boolean): Set<string> => {
  const quoted = code.match(strings) ?? [];
  const uncommented = stripped ? code.replace(strings, ' ').replace(comments, ' ') : code;
  const rest = uncommented.replace(strings, ' ').replace(numbers, ' ');
  const bare = (rest.match(words) ?? []).filter((word) => word !== 'true' && word !== 'false');
  return new Set([...quoted, ...bare]);
};

/**
 * Why a mutant's replacement is not a small bug of its original, or undefined: more than one
 * line, a change of whitespace only, or a word or string the original lacks, its line and block
 * comments left out when `stripped`.
 */
export const replacementReason = (mutant: Mutant, stripped = true): string | undefined => {
  if (/[\r\n\p{Zl}\p{Zp}]/u.test(mutant.replacement)) {
    return 'the replacement is more than one line';
  }
  if (squash(mutant.replacement) === squash(mutant.original)) {
    return 'the replacement changes nothing';
  }
  // A mutant may only change operators and number or boolean literals, or delete or reorder
  // existing code: a small bug, never a new capability.
  const known = names(mutant.original, stripped);
  const added = [...names(mutant.replacement, stripped)].filter((name) => !known.has(name));
  return added.length > 0 ? `the replacement adds ${added.join(', ')}` : undefined;
};

// Written by its code point: a literal one is invisible in the source.
const byteOrderMark = String.fromCodePoint(0xfeff);

// Applies a parsed mutant to the content of its file (undefined when the file does not exist).
// The line is the one whose text, ignoring leading and trailing whitespace, is the original:
// the mutant's line number when that line matches, otherwise the only line that does.
// Reviewers' line numbers are often off, and the text is what makes the edit exact.
export const editFile = (mutant: Mutant, content: string | undefined): LineEdit => {
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

// The extensions of the languages whose comments are `//` and `/* */`: JavaScript and TypeScript,
// and the C family. Elsewhere a comment counts as the line's text (ADR 0311).
const C_COMMENTS = new Set(
  'js mjs cjs jsx ts mts cts tsx c h cc cpp cxx hh hpp hxx cs java kt kts go rs swift scala dart'.split(
    ' ',
  ),
);

const commentsKnown = (file: string): boolean =>
  C_COMMENTS.has(/\.([^./]+)$/.exec(file)?.[1]?.toLowerCase() ?? '');

/** A file the batch's change left at its head: its text, and the lines the change added to it. */
export interface ChangedFile {
  content: string;
  added: ReadonlySet<number>;
}

/** What a target repository's mutant is checked against (ADR 0311). */
export interface TargetChange {
  /** Whether a path is in a code area of the effective test map (ADR 0274). */
  inCode: (path: string) => boolean;
  /** The file at `path` when the change added a line to it; else undefined. */
  changed: (path: string) => ChangedFile | undefined;
}

/** A valid mutant with the line it edits and the file's content after the edit, or why not. */
export type MutantVerdict =
  | { ok: true; mutant: Mutant; line: number; content: string }
  | { ok: false; reason: string };

/**
 * Checks a mutant Brett proposed for a target repository (ADR 0311): a plain path in a code area
 * of the test map, a line the change added, and a replacement that is a small bug of it.
 */
export const mutantCheck = (mutant: Mutant, change: TargetChange): MutantVerdict => {
  // The name is model output; quoted, its control characters cannot forge a line.
  const name = JSON.stringify(mutant.file);
  if (!isPlainPath(mutant.file))
    return { ok: false, reason: `${name} is not a plain relative path` };
  if (!change.inCode(mutant.file)) {
    return { ok: false, reason: `${name} is in no code area of the test map` };
  }
  const file = change.changed(mutant.file);
  if (file === undefined) {
    return { ok: false, reason: `${name} is not a file the change added a line to` };
  }
  const edit = editFile(mutant, file.content);
  if (!edit.ok) return edit;
  if (!file.added.has(edit.line)) {
    return {
      ok: false,
      reason: `line ${edit.line} of ${mutant.file} is not a line the change added`,
    };
  }
  const reason = replacementReason(mutant, commentsKnown(mutant.file));
  return reason === undefined
    ? { ok: true, mutant, line: edit.line, content: edit.content }
    : { ok: false, reason };
};
