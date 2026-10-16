// Decides whether a mutant was killed, from the test outcomes of a run without it (the baseline)
// and a run with it (issue #43). Only a test that fails because of the mutant kills it.

export interface Outcome {
  file: string;
  test: string[];
  ok: boolean;
}

export type Verdict =
  | { kind: 'killed'; by: Outcome[] }
  | { kind: 'survived'; passing: number }
  | { kind: 'no baseline' };

// The outcomes in the reporter's output, one JSON line each, or why they cannot be read.
export const parseOutcomes = (_text: string): Outcome[] | string => {
  throw new Error('not implemented');
};

export const verdictOf = (_baseline: Outcome[], _run: Outcome[]): Verdict => {
  throw new Error('not implemented');
};
