// Decides whether a Brett mutant is valid and what it does to its file (ADR 0021, issue #43).
// Brett answers with structured edits instead of patches, so no hand-written hunk header can
// make a mutant fail to apply: each mutant replaces one existing line of a file under src/ or
// scripts/, where the gate, the check and the review tooling live (ADR 0040).

import { posix } from 'node:path';

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
// A deleted file is gone at the head; a renamed or copied one counts by its new path.
export const touchedFiles = (nameStatus: string): string[] =>
  nameStatus
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter(([status = '', path]) => path !== undefined && !status.startsWith('D'))
    .map((fields) => fields.at(-1) ?? '');

// Checks one entry of Brett's answer on its own: its shape, its path and the allowlist, and,
// given the files the change touches, that it edits one of them (#140).
export const parseMutant = (value: unknown, touched?: readonly string[]): MutantCheck => {
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
  if (touched !== undefined && !touched.includes(mutant.file)) {
    return { ok: false, reason: `${JSON.stringify(mutant.file)} is not a file the change touches` };
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

// A file of the change at its head: its path from the repository root and its text.
export interface ChangedFile {
  path: string;
  content: string;
}

// A mutant the checker writes itself, beside Brett's (#223).
export type ScriptedMutant = Mutant & { description: string; source: 'script' };

// The code of a file without its strings, comments and import statements, so a function's name
// in a test's title or in an import is not a use of it.
const codeOf = (content: string): string =>
  content
    .split(/\r?\n/)
    .map((line) => line.replace(strings, '""').replace(comments, ' '))
    .join('\n')
    .replace(/^\s*import\b[^;]*;/gm, ' ');

// The file a test imports `name` from by a relative `import { … } from '…'`, as a path from the
// repository root, or undefined.
const importedFrom = (test: ChangedFile, name: string): string | undefined => {
  for (const [, names = '', , from = ''] of test.content.matchAll(
    /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])(\.[^'"]*)\2/gm,
  )) {
    if (names.split(',').some((entry) => entry.trim() === name)) {
      return posix.normalize(posix.join(posix.dirname(test.path), from));
    }
  }
  return undefined;
};

// The index of the bracket that closes the one at `open`, or -1.
const closing = (code: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index] ?? '';
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char) && --depth === 0) return index;
  }
  return -1;
};

// The arguments of a call, split at its top-level commas.
const argumentsOf = (text: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return [...parts, text.slice(start).trim()].filter((part) => part !== '');
};

// A function's name inside a regular expression: `$` is the one character of a name it reads
// specially.
const literal = (name: string): string => name.replace(/\$/g, '\\$');

const mentions = (code: string, name: string): number =>
  code.match(new RegExp(`(?<![\\p{ID_Continue}$])${literal(name)}(?![\\p{ID_Continue}$])`, 'gu'))
    ?.length ?? 0;

const EQUAL = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual']);

// What one assertion expects of `name`: `assert.equal(name(…), true|false)` and its strict and
// deep forms, `assert.ok(name(…))` and `assert(name(…))`, each also with `!name(…)`. Undefined for
// any other form.
const expected = (
  method: string | undefined,
  args: string[],
  name: string,
): boolean | undefined => {
  const [actual = '', value] = args;
  const call = new RegExp(`^(!?)\\s*${literal(name)}\\s*\\(`, 'u').exec(actual);
  const open = call === null ? -1 : call[0].length - 1;
  // A call that names the function again in its arguments is read here, but leaves a mention
  // over that sameAnswer's count then refuses.
  if (call === null || closing(actual, open) !== actual.length - 1) return undefined;
  const negated = call[1] === '!';
  if (method === undefined || method === 'ok') return !negated;
  if (EQUAL.has(method) && (value === 'true' || value === 'false')) {
    return (value === 'true') !== negated;
  }
  return undefined;
};

// The one value every assertion on `name` in the tests expects; undefined when the tests have
// none, expect both, or mention the function in a form `expected` does not read, which Brett's
// prompt still covers.
const sameAnswer = (code: string, name: string): boolean | undefined => {
  const values = new Set<boolean>();
  let read = 0;
  for (const match of code.matchAll(/(?<![\p{ID_Continue}$.])assert(?:\.(\w+))?\s*\(/gu)) {
    const open = match.index + match[0].length - 1;
    const close = closing(code, open);
    if (close === -1) return undefined;
    const value = expected(match[1], argumentsOf(code.slice(open + 1, close)), name);
    if (value !== undefined) {
      values.add(value);
      read += 1;
    }
  }
  const [only] = values;
  return read > 0 && read === mentions(code, name) && values.size === 1 ? only : undefined;
};

const identifier = '([\\p{ID_Start}$_][\\p{ID_Continue}$]*)';
// `const name = (…): boolean => …` on one line, and `function name(…): boolean {`.
const arrow = new RegExp(
  `^(?:export\\s+)?(?:const|let)\\s+${identifier}\\s*=\\s*(?:<[^>]*>\\s*)?\\(.*?\\)\\s*:\\s*boolean\\s*=>\\s*(.*)$`,
  'u',
);
const declaration = new RegExp(
  `^(?:export\\s+)?function\\s+${identifier}\\s*(?:<[^>]*>\\s*)?\\(.*\\)\\s*:\\s*boolean\\s*\\{$`,
  'u',
);

interface BooleanFunction {
  name: string;
  line: number;
  original: string;
  // The line with the function's result written as `value` combined with `result`.
  rewrite: (value: boolean) => string;
}

const combined = (value: boolean, result: string): string =>
  value ? `true || (${result})` : `false && (${result})`;

// The index of the block body's only `return` line after the header at `start`, or undefined.
const onlyReturn = (lines: string[], start: number): number | undefined => {
  let depth = 0;
  const returns: number[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const code = (lines[index] ?? '').replace(strings, '""').replace(comments, ' ');
    if (index > start && /\breturn\b/.test(code)) returns.push(index);
    for (const char of code) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    if (depth === 0) return returns.length === 1 ? returns[0] : undefined;
  }
  return undefined;
};

// The functions of a file declared to return a boolean whose result is one expression on one
// line: an arrow's expression body, or a block's only `return <expression>;`.
const booleanFunctions = (content: string): BooleanFunction[] => {
  const lines = content.split(/\r?\n/);
  return lines.flatMap((text, index): BooleanFunction[] => {
    const header = text.trim();
    const [, arrowName, body = ''] = arrow.exec(header) ?? [];
    const [, declared] = declaration.exec(header) ?? [];
    if (arrowName !== undefined && body !== '{') {
      if (!body.endsWith(';')) return [];
      const head = text.trimEnd().slice(0, -body.length);
      const rewrite = (value: boolean) => `${head}${combined(value, body.slice(0, -1).trim())};`;
      return [{ name: arrowName, line: index + 1, original: text.trimEnd(), rewrite }];
    }
    const name = arrowName ?? declared;
    const at = name === undefined ? undefined : onlyReturn(lines, index);
    const statement = at === undefined ? '' : (lines[at] ?? '').trimEnd();
    const [, indent, result] = /^(\s*)return\s+(.+);$/.exec(statement) ?? [];
    if (name === undefined || at === undefined || result === undefined) return [];
    const rewrite = (value: boolean) => `${indent}return ${combined(value, result)};`;
    return [{ name, line: at + 1, original: statement, rewrite }];
  });
};

// For each function of the changed source files declared to return a boolean, when every
// assertion on it in the changed test files expects the same value, the mutant that makes it
// return that value for every input: it survives exactly when the tests cannot tell the function
// from a stub that always gives that answer. Brett's prompt asked for it, and a model gives what
// it is asked for usually, not always (#223).
export const sameAnswerMutants = (
  sources: readonly ChangedFile[],
  tests: readonly ChangedFile[],
): ScriptedMutant[] => {
  const read = tests.map((test) => ({ ...test, code: codeOf(test.content) }));
  const found = sources.flatMap((source) =>
    booleanFunctions(source.content).map((fn) => ({ ...fn, file: source.path })),
  );
  // The tests are matched to a function by its name, so a name declared twice is left to Brett.
  const once = (name: string): boolean => found.filter((fn) => fn.name === name).length === 1;
  return found.flatMap(({ name, file, line, original, rewrite }) => {
    // Every test file that uses the name imports it from the function's own file.
    const using = read.filter((test) => mentions(test.code, name) > 0);
    const imported = using.every((test) => importedFrom(test, name) === file);
    const code = using.map((test) => test.code).join('\n');
    const value = once(name) && imported ? sameAnswer(code, name) : undefined;
    if (value === undefined) return [];
    const description = `${name} returns ${value} for every input: every assertion on it in the changed tests expects ${value}`;
    return [
      { file, line, original, replacement: rewrite(value), description, source: 'script' as const },
    ];
  });
};

// The line the command prints for a mutant of sameAnswerMutants.
export const sameAnswerLine = (mutant: ScriptedMutant): string =>
  `${mutant.file}:${mutant.line} ${mutant.description.replace(/ returns (true|false) .*$/, ' always $1')}`;
