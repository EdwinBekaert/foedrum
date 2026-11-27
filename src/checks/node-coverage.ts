// The V8 coverage Node's processes wrote in a folder (NODE_V8_COVERAGE) while the mutant step's
// baseline ran the test check, read per test file (#1176, ADR 0431, ADR 0303): each process's
// record is the test file's, which is the first script of the tree it compiled, the one it was
// started on, before the files that file imports. The file system's reading; mutant-reach.ts says
// which test files reached a line.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../formats/json.ts';
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

/**
 * The coverage the processes wrote in `folder` for the tree at `root`, per test file by its path in
 * the tree, each with the ranges of every file of the tree its process loaded; or why a record
 * cannot be read, or two processes started on one file. A folder never made holds none.
 */
export const readNodeCoverage = (folder: string, root: string): TestCoverage | string => {
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith('.json'));
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? new Map() : `cannot read the folder: ${codeOf(error)}`;
  }
  // The loader may name the tree by its real path (a link, a short name).
  const roots = [root, realPath(root)];
  const inTree = (file: string): string | undefined => {
    for (const each of roots) {
      const path = pathInside(each, file);
      if (path !== undefined) return path;
    }
    return undefined;
  };
  const records = new Map<string, Map<string, Range[]>>();
  for (const name of names.sort()) {
    // Never the folder's own message, which names the path.
    const unreadable = (why: string) => `cannot read ${quoted(name)}: ${why}`;
    let text: string;
    try {
      text = readFileSync(join(folder, name), 'utf8');
    } catch (error) {
      return unreadable(codeOf(error));
    }
    const parsed = V8Coverage.safeParse(parseJson(text));
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
    const [entry] = scripts.keys();
    if (entry === undefined) continue;
    if (records.has(entry)) return `two coverage records name the test file ${quoted(entry)}`;
    records.set(entry, scripts);
  }
  return records;
};
