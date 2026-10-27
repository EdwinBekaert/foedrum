// Which test files a change reaches (ADR 0241): the test files under test/{unit,property,chaos}/
// whose relative imports lead to a changed file, read as text with no dependency and no type
// checker. The shell (scripts/affected-tests.ts) finds the change with git and reads the files.

/** Every test file, with why; or the test files the change reaches, sorted, perhaps none. */
export type Affected = { kind: 'all'; why: string } | { kind: 'some'; files: string[] };

/** Whether a path, relative to the checkout with `/`, is a test file npm run check runs. */
export const isTestFile = (_path: string): boolean => {
  throw new Error('not implemented');
};

/**
 * The test files a change reaches: `changed` are the changed paths, relative to the checkout with
 * `/`; `texts` holds every TypeScript file of the working tree by such a path.
 */
export const affectedTests = (
  _changed: readonly string[],
  _texts: ReadonlyMap<string, string>,
): Affected => {
  throw new Error('not implemented');
};
