// Decides whether a pre-existing issue draft of /brew-review can be filed as it is (issue #267).
// Stage 5 sends the draft to GitHub with `gh api --input`, and the approval prompt shows only the
// file's path, so a model-written draft with extra keys or a multi-line title would be sent as it
// is. This file imports nothing, so the review skill can run it from its criteria copy.

const titleLimit = 256;
const bodyLimit = 65_536;

export type DraftCheck = { ok: true; title: string } | { ok: false; problems: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// GitHub counts characters, not UTF-16 units.
const length = (text: string): number => [...text].length;

const lineBreak = /[\n\v\f\r\u0085\u2028\u2029]/u;
const control = /\p{Cc}/u;
// Bidi overrides and zero-width characters: a title can show the user other text than it files.
const format = /\p{Cf}/gu;

const escapeChar = (char: string): string => {
  const hex = (char.codePointAt(0) ?? 0).toString(16);
  return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
};

// Text from outside in a problem line, such as a path in a read error: with its control and
// format characters escaped, it cannot forge an output line or reorder one.
export const escapeText = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, escapeChar);

// Model-written text in a problem line, quoted: JSON.stringify escapes line breaks and control
// characters, and format characters are escaped too.
const quote = (text: string): string => JSON.stringify(text).replace(format, escapeChar);

// The keys of the draft object itself, as often as the text names them: JSON.parse keeps the
// last of two equal keys, but `gh api --input` sends the text, and GitHub may keep another.
// The text is valid JSON here, so a string is a key when it is in the object itself (depth 1)
// and a colon follows it.
const topLevelKeys = (text: string): string[] => {
  const keys: string[] = [];
  const colon = /\s*:/y;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      colon.lastIndex = end + 1;
      if (depth === 1 && colon.test(text)) keys.push(JSON.parse(text.slice(index, end + 1)));
      index = end;
    } else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
  }
  return keys;
};

const duplicates = (keys: string[]): string[] => [
  ...new Set(keys.filter((key, index) => keys.indexOf(key) !== index)),
];

const fieldProblem = (
  draft: Record<string, unknown>,
  key: 'title' | 'body',
  limit: number,
): string | undefined => {
  if (!Object.hasOwn(draft, key)) return `"${key}" is missing`;
  const value = draft[key];
  if (typeof value !== 'string') return `"${key}" is not a string`;
  if (key === 'title') {
    if (value.trim() === '') return '"title" is empty';
    if (lineBreak.test(value)) return '"title" is more than one line';
    if (control.test(value)) return '"title" has a control character';
    if (value.match(format) !== null) return '"title" has an invisible format character';
  }
  const count = length(value);
  return count > limit ? `"${key}" has ${count} characters, more than ${limit}` : undefined;
};

// Checks the text of a draft file: one line per problem, or the title it would file.
export const checkDraft = (text: string): DraftCheck => {
  let draft: unknown;
  try {
    // A draft saved on Windows may start with a byte order mark (CLAUDE.md, Cross-platform).
    draft = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    // The parser's message quotes the draft's text.
    return { ok: false, problems: [`the draft is not JSON: ${quote((error as Error).message)}`] };
  }
  if (!isObject(draft)) return { ok: false, problems: ['the draft is not a JSON object'] };
  const problems = [
    ...duplicates(topLevelKeys(text)).map((key) => `duplicate key ${quote(key)}`),
    ...Object.keys(draft)
      .filter((key) => key !== 'title' && key !== 'body')
      .map((key) => `unexpected key ${quote(key)}`),
  ];
  for (const problem of [
    fieldProblem(draft, 'title', titleLimit),
    fieldProblem(draft, 'body', bodyLimit),
  ]) {
    if (problem !== undefined) problems.push(problem);
  }
  // With no problem, the title is a string; the test of its type only tells the compiler.
  if (problems.length === 0 && typeof draft.title === 'string')
    return { ok: true, title: draft.title };
  return { ok: false, problems };
};
