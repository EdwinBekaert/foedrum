// `node scripts/mutant-tests.ts <tree> <file>...`: prints, one per line, the test files of the
// tree that the mutation check of /brew-review runs for mutants of the given files (#140):
// those in test/unit/, test/property/ and test/chaos/ that import one of them directly or
// through one module. With --coverage, the test files a coverage run by hand needs: those
// of every layer that reach one of them at any depth or name it in a string.
// mutant-tests/core.ts decides. Prints nothing when no test file does.

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { coveringTestsFor, testsFor } from './mutant-tests/core.ts';

export type Result = { ok: boolean; lines: string[] };

// The folders whose TypeScript files can import a mutated file, or be a test that does.
const FOLDERS = ['src', 'scripts', 'test'];

// Every .ts regular file under the folders, by its path relative to the tree with /. A folder the
// tree does not have is left out, and so is a link: the pull request's tree may hold one to a
// device or a file outside it, which would be read without end.
const readSources = async (tree: string): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  for (const folder of FOLDERS) {
    let entries: Dirent[];
    try {
      entries = await readdir(join(tree, folder), { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith('.ts'))) {
      const path = join(entry.parentPath, entry.name);
      sources.set(relative(tree, path).split(sep).join('/'), await readFile(path, 'utf8'));
    }
  }
  return sources;
};

const select =
  (choose: (sources: ReadonlyMap<string, string>, files: readonly string[]) => string[]) =>
  async (tree: string, files: readonly string[]): Promise<Result> => {
    let sources: Map<string, string>;
    try {
      if (!(await stat(tree)).isDirectory()) {
        return { ok: false, lines: [`${tree} is not a folder`] };
      }
      sources = await readSources(tree);
    } catch (error) {
      return { ok: false, lines: [`cannot read ${tree}: ${(error as Error).message}`] };
    }
    return { ok: true, lines: choose(sources, files) };
  };

// The tests the mutation check runs for mutants of `files`.
export const mutantTests = select(testsFor);

// The tests a coverage run by hand needs for `files` (`--coverage`): every layer, any depth.
export const coveringTests = select(coveringTestsFor);

export interface MainResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

// The command line: its arguments, and what it prints and exits with.
export const main = async (argv: readonly string[]): Promise<MainResult> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { coverage: { type: 'boolean' } },
    allowPositionals: true,
  });
  const [tree, ...files] = positionals;
  if (tree === undefined || files.length === 0) {
    const usage = 'usage: node scripts/mutant-tests.ts [--coverage] <tree> <file>...';
    return { exitCode: 2, stdout: [], stderr: [usage] };
  }
  const { ok, lines } = await (values.coverage ? coveringTests : mutantTests)(tree, files);
  return ok
    ? { exitCode: 0, stdout: lines, stderr: [] }
    : { exitCode: 1, stdout: [], stderr: lines.map((line) => `mutant-tests: ${line}`) };
};

if (import.meta.main) {
  const { exitCode, stdout, stderr } = await main(process.argv.slice(2));
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);
  process.exitCode = exitCode;
}
