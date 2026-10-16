// `node scripts/mutant-tests.ts <tree> <file>...`: prints, one per line, the test files of the
// tree that the mutation check of /brew-review runs for mutants of the given files (#140):
// those in test/unit/, test/property/ and test/chaos/ that import one of them directly or
// through one module. mutant-tests/core.ts decides. Prints nothing when no test file does.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { testsFor } from './mutant-tests/core.ts';

export type Result = { ok: boolean; lines: string[] };

// The folders whose TypeScript files can import a mutated file, or be a test that does.
const FOLDERS = ['src', 'scripts', 'test'];

// Every .ts file under the folders, by its path relative to the tree with /. A folder the tree
// does not have is left out.
const readSources = async (tree: string): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  for (const folder of FOLDERS) {
    let entries: string[];
    try {
      entries = await readdir(join(tree, folder), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.filter((name) => name.endsWith('.ts'))) {
      const path = join(folder, entry);
      sources.set(path.split(sep).join('/'), await readFile(join(tree, path), 'utf8'));
    }
  }
  return sources;
};

export const mutantTests = async (tree: string, files: readonly string[]): Promise<Result> => {
  let sources: Map<string, string>;
  try {
    if (!(await stat(tree)).isDirectory()) return { ok: false, lines: [`${tree} is not a folder`] };
    sources = await readSources(tree);
  } catch (error) {
    return { ok: false, lines: [`cannot read ${tree}: ${(error as Error).message}`] };
  }
  return { ok: true, lines: testsFor(sources, files) };
};

if (import.meta.main) {
  const [tree, ...files] = process.argv.slice(2);
  if (tree === undefined || files.length === 0) {
    console.error('usage: node scripts/mutant-tests.ts <tree> <file>...');
    process.exitCode = 2;
  } else {
    const { ok, lines } = await mutantTests(tree, files);
    if (ok) for (const line of lines) console.log(line);
    else {
      for (const line of lines) console.error(`mutant-tests: ${line}`);
      process.exitCode = 1;
    }
  }
}
