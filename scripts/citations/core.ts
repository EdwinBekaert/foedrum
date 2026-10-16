// Decides whether a reviewer's citation (a file and a line) points at a line of the reviewed
// commit (issue #43). The planted-defect run in #104 had reviewers cite lines 27 and 34 of a
// 20-line file; the review skill checks every citation before it writes the summary.

export interface Citation {
  file: string;
  line: number;
}

// A finding that cites no location at all is fine: it has no citation to check.
export type CitationCheck = { ok: true; citation?: Citation } | { ok: false; reason: string };

// A relative path with forward slashes, with no empty, `.` or `..` segment, and no backslash,
// drive colon, control character or line separator. The same check as in
// scripts/mutants/core.ts, copied on purpose: this file imports nothing, so the review skill can
// take it from a pull request and the mutant checker from its base without the two matching.
const isPlainPath = (file: string): boolean =>
  file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
  !/[\\:\p{Cc}\p{Zl}\p{Zp}]/u.test(file);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The findings (a lens) or proposals (simplify) of a reviewer's answer, or why there are none.
export const entriesOf = (answer: unknown): unknown[] | string => {
  const lists = isObject(answer)
    ? [answer.findings, answer.proposals].filter((list) => Array.isArray(list))
    : [];
  return lists.length > 0 ? lists.flat() : 'the answer has no "findings" or "proposals" list';
};

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

// Checks one entry's citation on its own: a plain path and a line number.
export const parseCitation = (entry: unknown): CitationCheck => {
  if (!isObject(entry)) return { ok: false, reason: 'the entry is not an object' };
  const { file, line } = entry;
  if (absent(file) && absent(line)) return { ok: true };
  if (typeof file !== 'string') return { ok: false, reason: '"file" is not a string' };
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return { ok: false, reason: '"line" is not a line number' };
  }
  if (!isPlainPath(file)) {
    // The path is model output; quoted, its control characters cannot forge an output line.
    return { ok: false, reason: `${JSON.stringify(file)} is not a path in the repository` };
  }
  return { ok: true, citation: { file, line } };
};

// Checks the citation against the cited file's content (undefined when it does not exist).
// A final newline does not start another line.
export const checkLine = (citation: Citation, content: string | undefined): CitationCheck => {
  const { file, line } = citation;
  if (content === undefined) return { ok: false, reason: `${file} does not exist` };
  const count = content.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0;
  return line <= count
    ? { ok: true, citation }
    : { ok: false, reason: `${file} has ${count} lines, not ${line}` };
};
