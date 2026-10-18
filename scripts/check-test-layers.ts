// Part of `npm run check`: fails when a file under test/unit/, test/property/, test/chaos/ or
// test/helpers/ imports node:child_process or the real process runner (spawnProcess or
// execProcess). npm test runs the first three and they import the helpers, so none of them may
// start a process (ADR 0021). Tests that run real tools belong in test/integration/. Exit 0:
// clean. Exit 1: one line per problem on stdout.
// It sees direct imports only: a test that starts a process through a module it imports is not
// caught here, but at run time: npm test's preload (scripts/refuse-process-starts.ts, ADR 0038)
// makes child_process's process starts throw in every test process and fails the file.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

export interface LayerProblem {
  // Relative to the scanned directory, with forward slashes.
  file: string;
  // The line of the finding, from 1, when it is about one.
  line?: number;
  problem: string;
}

// Files in those folders that may import child_process or the real process runner anyway, by
// path relative to test/ with forward slashes, each with the reason. Empty by default: move a
// test that needs a real process to test/integration/ instead. An entry whose file imports
// neither is itself reported, so the list cannot go stale.
export const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  // ['unit/example.test.ts', 'why this test must start a process'],
]);

const SOURCE_FILE = /\.[cm]?[jt]s$/;
// `import … from`, `export … from`, `import '…'`, `import('…')` and `require('…')`, with or
// without the node: prefix. A string or comment that only names the module does not match; one
// that contains an import statement, and `import type`, do: the guard errs on the side of failing.
const CHILD_PROCESS_IMPORT = /\b(?:from|import|require)\s*\(?\s*(['"`])(?:node:)?child_process\1/;

// The real process runner (#12): spawnProcess, execProcess or streamProcess from src/platform/processes.ts or
// scripts/process-runner.ts, imported by name, as a namespace, re-exported, or through `import()`
// or `require()`, whose bindings it cannot see. `import type` and the runner with a fake spawner
// (execProcessWith, streamProcessWith) do not match.
const RUNNER_MODULE = String.raw`(?<quote>['"\`])[^'"\`\n]*(?:platform/processes|process-runner)(?:\.[cm]?[jt]s)?\k<quote>`;
const RUNNER_STATIC = new RegExp(
  String.raw`\b(?:import|export)\s+(?!type\b)(?<bindings>[^;]*?)\bfrom\s*${RUNNER_MODULE}`,
  'g',
);
const RUNNER_DYNAMIC = new RegExp(String.raw`\b(?:import|require)\s*\(\s*${RUNNER_MODULE}`);
const RUNNER_BINDING = /\*|(?<!\btype\s+)\b(?:spawnProcess|execProcess|streamProcess)\b/;

const importsRealRunner = (source: string): boolean =>
  RUNNER_DYNAMIC.test(source) ||
  [...source.matchAll(RUNNER_STATIC)].some(({ groups }) =>
    RUNNER_BINDING.test(groups?.bindings ?? ''),
  );

const IMPORTS =
  'imports child_process, but unit, property and chaos tests start no processes: move the test to test/integration/ (ADR 0021)';
const RUNNER =
  'imports the real process runner, but unit, property and chaos tests start no processes: inject a fake runner, or move the test to test/integration/ (ADR 0021)';
const STALE =
  'is on the exception list but does not import child_process or the real process runner: remove the entry from scripts/check-test-layers.ts';

// What source files under dir import that they may not, by file relative to dir with forward
// slashes.
const findingsIn = (dir: string): LayerProblem[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => SOURCE_FILE.test(path))
    .flatMap((path) => {
      const source = readFileSync(join(dir, path), 'utf8');
      const file = path.split(sep).join('/');
      return [
        ...(CHILD_PROCESS_IMPORT.test(source) ? [{ file, problem: IMPORTS }] : []),
        ...(importsRealRunner(source) ? [{ file, problem: RUNNER }] : []),
      ];
    });

const problemsOf = (
  findings: LayerProblem[],
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] => {
  const problems = [
    ...findings.filter(({ file }) => !exceptions.has(file)),
    ...[...exceptions.keys()]
      .filter((file) => !findings.some((finding) => finding.file === file))
      .map((file) => ({ file, problem: STALE })),
  ];
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

// One folder; files and exceptions are relative to it.
export const checkTestLayer = (
  dir: string,
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] => problemsOf(findingsIn(dir), exceptions);

// The folders under test/ that npm test runs or that those tests import (ADR 0021).
export const NO_PROCESS_FOLDERS = ['unit', 'property', 'chaos', 'helpers'] as const;

// Scans NO_PROCESS_FOLDERS under testDir, skipping one that does not exist; files and exceptions
// are relative to testDir.
export const checkTestLayers = (
  testDir: string,
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] =>
  problemsOf(
    NO_PROCESS_FOLDERS.filter((folder) => existsSync(join(testDir, folder))).flatMap((folder) =>
      findingsIn(join(testDir, folder)).map(({ file, problem }) => ({
        file: `${folder}/${file}`,
        problem,
      })),
    ),
    exceptions,
  );

// Integration tests and their helpers that may start the real gh anyway, by path relative to test/
// with forward slashes, each with the reason (#220).
export const REAL_GH_EXCEPTIONS: ReadonlyMap<string, string> = new Map();

export interface RealGhFinding {
  line: number;
  problem: string;
}

// What in one source file can start the real gh, by line.
export const realGhFindings = (_source: string): RealGhFinding[] => {
  throw new Error('not implemented');
};

// The findings of the sources, by file relative to test/, and the stale exceptions.
export const realGhProblems = (
  _sources: ReadonlyMap<string, string>,
  _exceptions: ReadonlyMap<string, string>,
): LayerProblem[] => {
  throw new Error('not implemented');
};

if (import.meta.main) {
  const problems = checkTestLayers(join(import.meta.dirname, '..', 'test'), EXCEPTIONS);
  for (const { file, problem } of problems) process.stdout.write(`test/${file} ${problem}\n`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
