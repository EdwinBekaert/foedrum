// Part of `npm run check`: fails when a file under test/unit/ imports node:child_process, because
// unit tests start no processes (ADR 0021). Tests that run real tools belong in
// test/integration/. Exit 0: clean. Exit 1: one line per problem on stdout.

import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

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

const SOURCE_FILE = /\.[cm]?[jt]s$/;
// `import … from`, `export … from`, `import '…'`, `import('…')` and `require('…')`, with or
// without the node: prefix. Comments and other strings that merely name the module do not match.
const CHILD_PROCESS_IMPORT = /\b(?:from|import|require)\s*\(?\s*(['"`])(?:node:)?child_process\1/;

const IMPORTS =
  'imports child_process, but unit tests start no processes: move the test to test/integration/ (ADR 0021)';
const STALE =
  'is on the exception list but does not import child_process: remove the entry from scripts/check-test-layers.ts';

export const checkTestLayer = (
  dir: string,
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] => {
  const importing = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => SOURCE_FILE.test(path))
    .filter((path) => CHILD_PROCESS_IMPORT.test(readFileSync(join(dir, path), 'utf8')))
    .map((path) => path.split(sep).join('/'));
  const problems = [
    ...importing
      .filter((file) => !exceptions.has(file))
      .map((file) => ({ file, problem: IMPORTS })),
    ...[...exceptions.keys()]
      .filter((file) => !importing.includes(file))
      .map((file) => ({ file, problem: STALE })),
  ];
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

if (import.meta.main) {
  const unit = join(import.meta.dirname, '..', 'test', 'unit');
  const problems = checkTestLayer(unit, EXCEPTIONS);
  for (const { file, problem } of problems) process.stdout.write(`test/unit/${file} ${problem}\n`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
