// The V8 coverage Node's processes wrote in a folder (NODE_V8_COVERAGE) while the mutant step's
// baseline ran the test check, read per test file (#1176, ADR 0431, ADR 0303): each process's
// record is the test file's, which is the first script of the tree it compiled that the baseline's
// test reports place a test in, before the files that file imports. A script a preload or a loader
// compiled before it is no test file. The file system's reading; mutant-reach.ts says which test
// files reached a line.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportPath } from '../formats/coverage-report.ts';
import { parseJson } from '../formats/json.ts';
import { MAX_REPORT_BYTES } from '../formats/test-report.ts';
import { readOutDocFile } from '../platform/bounded-read.ts';
import { errorCode } from '../platform/errors.ts';
import { pathInside } from '../platform/paths.ts';
import { realPath } from '../platform/real-path.ts';
import { z } from '../schemas/zod.ts';
import { quoted } from './gravity.ts';
import type { Range, TestCoverage } from './mutant-reach.ts';

const V8Coverage = z.object({
  result: z.array(
    z.object({
      url: z.string(),
      functions: z.array(
        z.object({
          ranges: z.array(
            z.object({
              startOffset: z.number().int(),
              endOffset: z.number().int(),
              count: z.number().int(),
            }),
          ),
        }),
      ),
    }),
  ),
});

/** An error's code, never its message, which may name a path; `an error` for one with no code. */
export const codeOf = (error: unknown): string => errorCode(error) ?? 'an error';

/** The most records read: a test run writes one per process, and a folder may hold what a test made. */
const MAX_RECORDS = 3000;

/**
 * The coverage the processes wrote in `folder` for the tree at `root`, per test file by its path in
 * the tree, each with the ranges of every file of the tree its process loaded; or why a record
 * cannot be read, or two processes started on one file. A test file is one of `located`, the files
 * the baseline's tests report (absolute or relative to the tree): a record that loaded none is no
 * test file's and is left out. A folder never made holds none. Each record is read as a test report
 * is, only a regular file of the tree and of a bounded size, as a test wrote it.
 */
export const readNodeCoverage = (
  folder: string,
  root: string,
  located: readonly string[],
): TestCoverage | string => {
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith('.json'));
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? new Map() : `cannot read the folder: ${codeOf(error)}`;
  }
  if (names.length > MAX_RECORDS) return `the folder holds more than ${MAX_RECORDS} records`;
  // The loader may name the tree by its real path (a link, a short name).
  const roots = [root, realPath(root)];
  const inTree = (file: string): string | undefined => {
    for (const each of roots) {
      const path = pathInside(each, file);
      if (path !== undefined) return path;
    }
    return undefined;
  };
  const tests = new Set(
    located.flatMap((file) => {
      const path = roots.map((each) => reportPath(file, each)).find((found) => found !== undefined);
      return path === undefined ? [] : [path];
    }),
  );
  const records = new Map<string, Map<string, Range[]>>();
  for (const name of names.sort()) {
    const unreadable = (why: string) => `cannot read ${quoted(name)}: ${why}`;
    const read = readOutDocFile(join(folder, name), MAX_REPORT_BYTES, root);
    // Never the reader's own reason, which may name a path a test chose.
    if (read.kind !== 'text') return unreadable('it is no plain file of a bounded size');
    const parsed = V8Coverage.safeParse(parseJson(read.text));
    if (!parsed.success) return unreadable('not V8 coverage');
    const scripts = new Map<string, Range[]>();
    for (const { url, functions } of parsed.data.result) {
      if (!url.startsWith('file:')) continue;
      let path: string | undefined;
      try {
        path = inTree(fileURLToPath(url));
      } catch {
        return unreadable('not V8 coverage');
      }
      if (path !== undefined)
        scripts.set(
          path,
          functions.flatMap(({ ranges }) => ranges),
        );
    }
    const entry = [...scripts.keys()].find((path) => tests.has(path));
    if (entry === undefined) continue;
    if (records.has(entry)) return `two coverage records name the test file ${quoted(entry)}`;
    records.set(entry, scripts);
  }
  return records;
};
