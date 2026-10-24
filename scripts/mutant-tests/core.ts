// Which test files a Brett mutant can fail (#140): the ones in test/unit/, test/property/ and
// test/chaos/ that import the mutated file directly or through one module in between. The
// mutation check runs only those, instead of the whole suite once per mutant.

import { posix } from 'node:path';

// `from '…'`, `import '…'` and `import('…')` with a relative specifier. Text in comments or strings
// may match too; that only adds a test file to the run. The whitespace splits only one way, so a
// long run of it after `import` does not backtrack.
const SPECIFIER = /\b(?:from|import)\s*(?:\(\s*)?(['"])(\.{1,2}\/[^'"\n]*)\1/g;

// The relative module specifiers a TypeScript source imports or re-exports, statically or with
// import(). Packages and node: built-ins are left out.
export const importsOf = (source: string): string[] =>
  [...source.matchAll(SPECIFIER)].map((match) => match[2] ?? '');

const TEST_FILE = /^test\/(?:unit|property|chaos)\/.+\.test\.ts$/;

// The files `file` imports, as paths relative to the tree.
const importedBy = (sources: ReadonlyMap<string, string>, file: string): string[] =>
  importsOf(sources.get(file) ?? '').map((specifier) =>
    posix.normalize(posix.join(posix.dirname(file), specifier)),
  );

// The two rounds of the mutation check (ADR 0171): the test files among `sources` that import
// one of `targets` directly, and the ones that import one only through one module, each sorted.
export const testRounds = (
  sources: ReadonlyMap<string, string>,
  targets: readonly string[],
): { direct: string[]; oneAway: string[] } => {
  const wanted = new Set(targets);
  const isWanted = (file: string): boolean => wanted.has(file);
  const direct: string[] = [];
  const oneAway: string[] = [];
  for (const test of [...sources.keys()].filter((file) => TEST_FILE.test(file)).sort()) {
    const modules = importedBy(sources, test);
    if (modules.some(isWanted)) direct.push(test);
    else if (modules.some((module) => importedBy(sources, module).some(isWanted))) {
      oneAway.push(test);
    }
  }
  return { direct, oneAway };
};

// The test files among `sources` (path relative to the tree, with /, to its text) that import
// one of `targets` directly or through one module, sorted.
export const testsFor = (
  sources: ReadonlyMap<string, string>,
  targets: readonly string[],
): string[] => {
  const { direct, oneAway } = testRounds(sources, targets);
  return [...direct, ...oneAway].sort();
};
