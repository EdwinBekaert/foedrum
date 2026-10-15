// Part of `npm run check`: fails when a file under test/unit/ imports node:child_process, because
// unit tests start no processes (ADR 0021). Tests that run real tools belong in
// test/integration/. Exit 0: clean. Exit 1: one line per problem on stdout.

export interface LayerProblem {
  // Relative to the scanned directory, with forward slashes.
  file: string;
  problem: string;
}

// Files under test/unit/ that may import child_process anyway, by path relative to test/unit/
// with forward slashes, each with the reason. Empty by default: move a test that needs a real
// process to test/integration/ instead. An entry whose file no longer imports child_process is
// itself reported, so the list cannot go stale.
export const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  // ['example.test.ts', 'why this unit test must start a process'],
]);

export const checkTestLayer = (
  _dir: string,
  _exceptions: ReadonlyMap<string, string>,
): LayerProblem[] => {
  throw new Error('not implemented');
};
