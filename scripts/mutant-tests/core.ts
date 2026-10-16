// Which test files a Brett mutant can fail (#140): the ones in test/unit/, test/property/ and
// test/chaos/ that import the mutated file directly or through one module in between. The
// mutation check runs only those, instead of the whole suite once per mutant.

// The relative module specifiers a TypeScript source imports or re-exports, statically or with
// import(). Packages and node: built-ins are left out.
export const importsOf = (_source: string): string[] => {
  throw new Error('not implemented');
};

// The test files among `sources` (path relative to the tree, with /, to its text) that import
// one of `targets` directly or through one module, sorted.
export const testsFor = (
  _sources: ReadonlyMap<string, string>,
  _targets: readonly string[],
): string[] => {
  throw new Error('not implemented');
};
