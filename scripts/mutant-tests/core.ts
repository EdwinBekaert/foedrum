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

// The test files among `sources`, in every layer, that reach one of `targets` through imports
// at any depth, or name one in a string: the tests the coverage delta runs.
export const coveringTestsFor = (
  sources: ReadonlyMap<string, string>,
  targets: readonly string[],
): string[] => {
  const imports = new Map([...sources.keys()].map((file) => [file, importedBy(sources, file)]));
  // Every file that reaches a target, found by walking back over the imports until none is new.
  const reaching = new Set(targets);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, modules] of imports) {
      if (!reaching.has(file) && modules.some((module) => reaching.has(module))) {
        reaching.add(file);
        grew = true;
      }
    }
  }
  const names = (test: string): boolean =>
    targets.some((target) => namesFile(sources.get(test) ?? '', target));
  return [...sources.keys()]
    .filter((file) => ANY_TEST_FILE.test(file))
    .filter((test) => reaching.has(test) || names(test))
    .sort();
};

// A test file of any layer; fixtures are data, not tests.
const ANY_TEST_FILE = /^test\/(?!fixtures\/).+\.test\.ts$/;

const STRING = /(['"`])([^'"`\n]*)\1/g;

// Whether `source` has a string that is `file`'s name, `file` itself or a path ending in it, as a
// test that starts the file as a process has: join(root, 'scripts', 'precheck.ts'). A path to
// another file with the same name does not count, nor does a relative import specifier, which
// the walk over the imports already follows.
const namesFile = (source: string, file: string): boolean => {
  const name = posix.basename(file);
  return [...source.matchAll(STRING)].some(
    ([, , text = '']) =>
      text === name || text === file || (!/^\.{1,2}\//.test(text) && text.endsWith(`/${file}`)),
  );
};
