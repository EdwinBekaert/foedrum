// `node scripts/mutant-coverage.ts <tree> <coverage-dir> <file>:<line>...`: prints, for each
// mutated line, the test files of the wide list whose child process ran it in the baseline,
// read from the V8 coverage files NODE_V8_COVERAGE wrote (#597, ADR 0303):
// `covered <file>:<line>: <test>...` or `not covered <file>:<line>`, or one line
// `fallback: <reason>` when the coverage cannot tell, and the mutation check runs its direct and
// wide rounds instead (ADR 0171). mutant-coverage/core.ts decides.

import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coveringTests,
  type Location,
  parseCoverage,
  quoted,
  type Range,
} from './mutant-coverage/core.ts';
import { testsFor } from './mutant-tests/core.ts';
import { readSources } from './mutant-tests.ts';

export interface MainResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

type Records = Map<string, Map<string, Range[]>>;

// The path of `file` in the tree, by the first of the tree's paths it lies under: the loader may
// name the tree by a path its real path resolves (a link, a short name, another drive letter).
const inTree = (roots: readonly string[], file: string): string | undefined => {
  for (const root of roots) {
    const path = relative(root, file);
    if (path !== '' && !path.startsWith('..') && !isAbsolute(path))
      return path.split(sep).join('/');
  }
  return undefined;
};

// Per test file of `tests`, the ranges of each script its child loaded, by its path in the tree.
// A test file two records name is left out, so it runs as covering every line.
const readRecords = async (
  roots: readonly string[],
  folder: string,
  tests: ReadonlySet<string>,
): Promise<Records | string> => {
  let names: string[];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return new Map();
  }
  const records: Records = new Map();
  const twice = new Set<string>();
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(join(folder, name), 'utf8');
    } catch (error) {
      // The code only: the message names the path, which holds the name unquoted.
      return `cannot read ${quoted(name)}: ${(error as NodeJS.ErrnoException).code ?? 'an error'}`;
    }
    const scripts = parseCoverage(text);
    if (typeof scripts === 'string') return `cannot read ${quoted(name)}: ${scripts}`;
    const byPath = new Map<string, Range[]>();
    for (const [url, ranges] of scripts) {
      if (!url.startsWith('file:')) continue;
      const path = inTree(roots, fileURLToPath(url));
      if (path !== undefined) byPath.set(path, ranges);
    }
    for (const test of [...byPath.keys()].filter((path) => tests.has(path))) {
      if (records.has(test)) twice.add(test);
      records.set(test, byPath);
    }
  }
  for (const test of twice) records.delete(test);
  return records;
};

export const main = async (argv: readonly string[]): Promise<MainResult> => {
  const [tree, folder, ...given] = argv;
  if (tree === undefined || folder === undefined || given.length === 0) {
    const usage = 'usage: node scripts/mutant-coverage.ts <tree> <coverage-dir> <file>:<line>...';
    return { exitCode: 2, stdout: [], stderr: [usage] };
  }
  let root: string;
  let sources: Map<string, string>;
  try {
    root = await realpath(tree);
    sources = await readSources(root);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: [],
      stderr: [`mutant-coverage: cannot read ${tree}: ${(error as Error).message}`],
    };
  }
  const locations: Location[] = [];
  for (const text of given) {
    const at = text.lastIndexOf(':');
    const file = text.slice(0, at);
    const line = Number(text.slice(at + 1));
    const count = sources.get(file)?.split('\n').length ?? 0;
    if (at < 0 || !Number.isInteger(line) || line < 1 || line > count) {
      const why = `mutant-coverage: ${text} is not a line of a source file of the tree`;
      return { exitCode: 1, stdout: [], stderr: [why] };
    }
    locations.push({ file, line });
  }
  const tests = testsFor(sources, [...new Set(locations.map(({ file }) => file))]);
  const records = await readRecords([root, resolve(tree)], folder, new Set(tests));
  if (typeof records === 'string') {
    return { exitCode: 0, stdout: [`fallback: ${records}`], stderr: [] };
  }
  const plan = coveringTests({ tests, records, sources, locations });
  if (plan.kind === 'fallback')
    return { exitCode: 0, stdout: [`fallback: ${plan.reason}`], stderr: [] };
  const stdout = plan.locations.map(({ file, line, tests: covering }) =>
    covering.length === 0
      ? `not covered ${file}:${line}`
      : `covered ${file}:${line}: ${covering.join(' ')}`,
  );
  return { exitCode: 0, stdout, stderr: [] };
};

if (import.meta.main) {
  const { exitCode, stdout, stderr } = await main(process.argv.slice(2));
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);
  process.exitCode = exitCode;
}
