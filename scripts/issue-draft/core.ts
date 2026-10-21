// Decides whether a pre-existing issue draft of /brew-review can be filed as it is (issue #267).
// Stage 6 sends the draft to GitHub with `gh api --input`, and the approval prompt shows only the
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

// Model-written text in a problem line: JSON.stringify escapes line breaks and control
// characters, so the text cannot forge an output line, and format characters are escaped too.
const quote = (text: string): string =>
  JSON.stringify(text).replace(format, (char) => {
    const hex = (char.codePointAt(0) ?? 0).toString(16);
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });

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
  const problems = Object.keys(draft)
    .filter((key) => key !== 'title' && key !== 'body')
    .map((key) => `unexpected key ${quote(key)}`);
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
