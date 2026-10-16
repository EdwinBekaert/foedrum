// `node scripts/mutants.ts <tree> <answer.json> [<n>]`: checks the mutants in Brett's answer
// against the brew-review scratch tree, or applies mutant <n> to it (issue #43).
// mutants/core.ts decides.

export const checkMutants = async (
  _tree: string,
  _answer: string,
): Promise<{ ok: boolean; lines: string[] }> => {
  throw new Error('not implemented');
};

export const applyMutant = async (
  _tree: string,
  _answer: string,
  _n: number,
): Promise<{ ok: boolean; lines: string[] }> => {
  throw new Error('not implemented');
};
