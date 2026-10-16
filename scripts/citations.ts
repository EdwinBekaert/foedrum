// `node scripts/citations.ts <checkout> <answer.json>`: checks that every finding in a reviewer's
// answer cites a file of the checkout and a line within it (issue #43). citations/core.ts
// decides. Exits 1 when the answer cannot be read.

type Result = { ok: boolean; lines: string[] };

export const checkCitations = async (_checkout: string, _answer: string): Promise<Result> => {
  throw new Error('not implemented');
};
