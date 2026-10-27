// Which test files a change reaches (ADR 0241): the test files under test/{unit,property,chaos}/
// whose relative imports lead to a changed file, read as text with no dependency and no type
// checker. The shell (scripts/affected-tests.ts) finds the change with git and reads the files.

import { posix } from 'node:path';

/** Every test file, with why; or the test files the change reaches, sorted, perhaps none. */
export type Affected = { kind: 'all'; why: string } | { kind: 'some'; files: string[] };

/** Whether a path, relative to the checkout with `/`, is a test file npm run check runs. */
export const isTestFile = (path: string): boolean =>
  /^test\/(?:unit|property|chaos)\/.+\.test\.ts$/.test(path);

// Files that set how every test runs.
const reachesEverything = (path: string): boolean =>
  ['package.json', 'package-lock.json', 'tsconfig.json'].includes(path) ||
  path.startsWith('scripts/') ||
  path.startsWith('test/helpers/');

const isDocs = (path: string): boolean =>
  path.startsWith('docs/') || (!path.includes('/') && path.endsWith('.md'));

// The relative specifiers of `… from '<path>'`, `import '<path>'` and `import('<path>')`. It may
// find one in a string or a comment too, which only adds a test file, never leaves one out.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"\n]*)\1/g;

const importsOf = (path: string, text: string): string[] =>
  [...text.matchAll(SPECIFIER)].map((match) => posix.join(posix.dirname(path), match[2] as string));

/**
 * The test files a change reaches: `changed` are the changed paths, relative to the checkout with
 * `/`; `texts` holds every TypeScript file of the working tree by such a path.
 */
export const affectedTests = (
  changed: readonly string[],
  texts: ReadonlyMap<string, string>,
): Affected => {
  const everything = changed.find(reachesEverything);
  if (everything !== undefined) return { kind: 'all', why: `${everything} changed` };
  const byPath = changed.find((path) => !path.endsWith('.ts') && !isDocs(path));
  if (byPath !== undefined) {
    return {
      kind: 'all',
      why: `${byPath} changed: a file that is not TypeScript, which tests read by path`,
    };
  }
  // Who imports each file, then every file that leads to a changed one.
  const importers = new Map<string, string[]>();
  for (const [path, text] of texts) {
    for (const imported of importsOf(path, text)) {
      importers.set(imported, [...(importers.get(imported) ?? []), path]);
    }
  }
  const reached = new Set(changed.filter((path) => path.endsWith('.ts')));
  for (const path of reached) {
    for (const importer of importers.get(path) ?? []) reached.add(importer);
  }
  return { kind: 'some', files: [...reached].filter(isTestFile).sort() };
};
