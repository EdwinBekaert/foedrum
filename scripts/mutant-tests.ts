// `node scripts/mutant-tests.ts <tree> <file>...`: prints, one per line, the test files of the
// tree that the mutation check of /brew-review runs for mutants of the given files (#140):
// those in test/unit/, test/property/ and test/chaos/ that import one of them directly or
// through one module. mutant-tests/core.ts decides. Prints nothing when no test file does.

export type Result = { ok: boolean; lines: string[] };

export const mutantTests = async (_tree: string, _files: readonly string[]): Promise<Result> => {
  throw new Error('not implemented');
};
