// The unblinding of a scored comparison (ADR 0403): a scorer's marks of the blinded lists, run by
// run, counted by setup through codes.md into the table #879's comments show. It counts marks and
// judges nothing: whether a finding names a key item is the scorer's.

/** The texts the table is made of: the key's markdown, the comparison's codes.md and the marks' JSON. */
export interface ScoreInput {
  key: string;
  codes: string;
  marks: string;
}

/**
 * The table of a scored comparison: per setup, its catches of each key item, its findings outside
 * the key, its tokens per batch and the models its Tasters ran on; throws on marks that do not fit.
 */
export const scoredTable = (_input: ScoreInput): string => {
  throw new Error('not implemented');
};
