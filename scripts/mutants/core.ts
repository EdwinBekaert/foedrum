// Decides whether a Brett mutant is valid and what it does to its file (ADR 0021, issue #43).
// Brett answers with structured edits instead of patches, so no hand-written hunk header can
// make a mutant fail to apply: each mutant replaces one existing line of a file under src/.

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

// A relative path with forward slashes, under src/, with no empty, `.` or `..` segment.
const underSrc = (file: string): boolean => {
  const segments = file.split('/');
  return (
    segments[0] === 'src' &&
    segments.length > 1 &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    !/[\\:]/.test(file)
  );
};

const strings = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;
const numbers = /(?<![\w$])\.?\d[\w.]*/g;
const words = /[A-Za-z_$][\w$]*/g;

// The strings and the words (identifiers, property names, keywords) in a line of code; the
// boolean literals count as literals, which a mutant may change.
const names = (code: string): Set<string> => {
  const quoted = code.match(strings) ?? [];
  const rest = code.replace(strings, ' ').replace(numbers, ' ');
  const bare = (rest.match(words) ?? []).filter((word) => word !== 'true' && word !== 'false');
  return new Set([...quoted, ...bare]);
};

// Checks one entry of Brett's answer on its own: its shape, its path and the allowlist.
export const parseMutant = (value: unknown): MutantCheck => {
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
  if (!underSrc(mutant.file)) {
    return { ok: false, reason: `${mutant.file} is not a file under src/` };
  }
  if (/[\r\n]/.test(mutant.replacement)) {
    return { ok: false, reason: 'the replacement is more than one line' };
  }
  if (mutant.replacement.trim() === mutant.original.trim()) {
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
  const indent = /^﻿?[ \t]*/.exec(at)?.[0] ?? '';
  const ending = /\r?\n$/.exec(at)?.[0] ?? '';
  const replacement = mutant.replacement.trim();
  lines[line - 1] = replacement === '' ? '' : `${indent}${replacement}${ending}`;
  return { ok: true, content: lines.join(''), line };
};
