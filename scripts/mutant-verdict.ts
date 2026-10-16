// `node scripts/mutant-verdict.ts <baseline.jsonl> <run.jsonl>`: says whether a mutant was
// killed, from the outcomes scripts/test-outcomes-reporter.ts wrote for a run without the mutant
// and a run with it (issue #43). mutant-verdict/core.ts decides. Exits 1 when an outcome file
// cannot be read or the baseline has no passing test.

type Result = { ok: boolean; lines: string[] };

export const mutantVerdict = async (_baseline: string, _run: string): Promise<Result> => {
  throw new Error('not implemented');
};
