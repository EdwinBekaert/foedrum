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

// Checks one entry of Brett's answer on its own: its shape, its path and the allowlist.
export const parseMutant = (_value: unknown): MutantCheck => {
  throw new Error('not implemented');
};

// Applies a parsed mutant to the content of its file (undefined when the file does not exist).
export const editFile = (_mutant: Mutant, _content: string | undefined): MutantEdit => {
  throw new Error('not implemented');
};
