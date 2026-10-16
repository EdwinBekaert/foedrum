// Decides whether a reviewer's citation (a file and a line) points at a line of the reviewed
// commit (issue #43). The planted-defect run in #104 had reviewers cite lines 27 and 34 of a
// 20-line file; the review skill checks every citation before it writes the summary.

export interface Citation {
  file: string;
  line: number;
}

// A finding that cites no location at all is fine: it has no citation to check.
export type CitationCheck = { ok: true; citation?: Citation } | { ok: false; reason: string };

// The findings (a lens) or proposals (simplify) of a reviewer's answer, or why there are none.
export const entriesOf = (_answer: unknown): unknown[] | string => {
  throw new Error('not implemented');
};

// Checks one entry's citation on its own: a plain path and a line number.
export const parseCitation = (_entry: unknown): CitationCheck => {
  throw new Error('not implemented');
};

// Checks the citation against the cited file's content (undefined when it does not exist).
export const checkLine = (_citation: Citation, _content: string | undefined): CitationCheck => {
  throw new Error('not implemented');
};
