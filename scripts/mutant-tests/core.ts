// Which test files a Brett mutant can fail (#140): the ones in test/unit/, test/property/ and
// test/chaos/ that import the mutated file directly or through one module in between. The
// mutation check runs only those, instead of the whole suite once per mutant.

import { posix } from 'node:path';

// `from '…'`, `import '…'` and `import('…')` with a relative specifier. Text in comments or strings
// may match too; that only adds a test file to the run.
const SPECIFIER = /\b(?:from|import)\s*\(?\s*(['"])(\.{1,2}\/[^'"\n]*)\1/g;

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

// The test files among `sources` (path relative to the tree, with /, to its text) that import
// one of `targets` directly or through one module, sorted.
export const testsFor = (
  sources: ReadonlyMap<string, string>,
  targets: readonly string[],
): string[] => {
  const wanted = new Set(targets);
  const isWanted = (file: string): boolean => wanted.has(file);
  return [...sources.keys()]
    .filter((file) => TEST_FILE.test(file))
    .filter((test) =>
      importedBy(sources, test).some(
        (module) => isWanted(module) || importedBy(sources, module).some(isWanted),
      ),
    )
    .sort();
};
