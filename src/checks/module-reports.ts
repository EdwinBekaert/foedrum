// The test and coverage reports of a test map's modules in a worktree (ADR 0274): where each module
// writes them, cleared before a run and read after it, for every check of a check step that reads
// them. No model.

import { statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parseJunit } from '../formats/junit.ts';
import { parseTap } from '../formats/tap.ts';
import { MAX_REPORT_BYTES } from '../formats/test-report.ts';
import { type BoundedRead, readOutDocFile } from '../platform/bounded-read.ts';
import { pathInside } from '../platform/paths.ts';
import { realPath } from '../platform/real-path.ts';
import { removeTree } from '../platform/remove.ts';
import type { TestMap, TestMapModule } from '../schemas/test-map.ts';
import type { TreeIn } from './check-runner.ts';
import type { MappedReport } from './red-proof.ts';
import { type EffectiveModule, effectiveMap, type MapRead, type reportPaths } from './test-map.ts';

/** A test report's file in a worktree: cleared before the test check runs, read after it. */
export interface ReportFiles {
  /** Clears the report only inside `root`, the worktree. */
  clear: (file: string, root: string) => void | Promise<void>;
  /** Reads the report only inside `root`, the worktree. */
  read: (file: string, root: string) => BoundedRead;
}

/**
 * The test report files of the real file system: removed, a folder included, through the platform's
 * removal, which retries a file another process holds open; read as an out doc is.
 */
export const fileReports: ReportFiles = {
  clear: async (file, root) => {
    // Resolved through links first: a linked folder on the path could point the removal anywhere.
    const resolved = join(realPath(dirname(file)), basename(file));
    if (pathInside(realPath(root), resolved) === undefined) {
      throw new Error('it is outside the worktree');
    }
    await removeTree(resolved);
  },
  read: (file, root) => readOutDocFile(file, MAX_REPORT_BYTES, root),
};

/** Whether `path` is a folder: a path that cannot be read is none. */
export const folderAt = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The test maps of a check step: where the batch's change starts, and at the step's commit. */
export interface StepMaps {
  base: string | undefined;
  before: MapRead;
  after: MapRead;
}

/** The effective map of a check step's maps, read by what each map lists alone. */
export const stepModules = (before: MapRead, after: TestMap): EffectiveModule[] =>
  effectiveMap(
    before.kind === 'map' ? before.map : undefined,
    after,
    { atBase: [], deleted: [] },
    false,
  );

/** The report paths `of` gives each module either map lists, each once (ADR 0274). */
export const pathsOf = (
  { before, after }: StepMaps,
  of: (module: TestMapModule) => string[],
): string[] => [
  ...new Set(
    [before, after].flatMap((read) => (read.kind === 'map' ? read.map.modules.flatMap(of) : [])),
  ),
];

/** A module's coverage report path, when it has a coverage tool. */
export const coveragePath = ({ coverage }: TestMapModule): string[] =>
  coverage === 'none' ? [] : [coverage.path];

/** A module's test report path, when Foedrum reads its format: it reads no TRX yet. */
export const testReportPath = ({ testReport }: TestMapModule): string[] =>
  testReport.format === 'trx' ? [] : [testReport.path];

/**
 * The test reports `module` wrote where the test map says, after a run in `worktree`: why the
 * step is Stuck on its environment when its pattern is refused or names a folder, or why it
 * failed when a report cannot be read or is not of its format (ADR 0274).
 */
export type ModuleReports = (
  module: TestMapModule,
  worktree: TreeIn,
) => { reports: MappedReport[] } | { stuck: string } | { failed: string };

/** The test reports of a module, found by `find`, read through `reports`. */
export const moduleReports =
  ({
    reports,
    find,
    isFolder,
  }: {
    reports: ReportFiles;
    find: typeof reportPaths;
    isFolder: (path: string) => boolean;
  }): ModuleReports =>
  (module, worktree) => {
    const { name, testReport } = module;
    const found = find(testReport.path, worktree.path);
    if ('refused' in found) {
      return {
        stuck: `the test report of module "${name}" cannot be looked for: ${found.refused}`,
      };
    }
    const read: MappedReport[] = [];
    for (const file of found.paths) {
      const shown = relative(worktree.path, file).split(sep).join('/');
      // A test report is a file: a folder is no report a brewer could fix by committing.
      if (isFolder(file)) {
        const extension = testReport.format === 'tap' ? 'tap' : 'xml';
        return {
          stuck: `the test report pattern ${testReport.path} of module "${name}" names a folder, ${shown}: name the report file in the test map, such as ${shown}/<file>.${extension} (ADR 0274)`,
        };
      }
      const text = reports.read(file, worktree.path);
      if (text.kind === 'missing') continue;
      if (text.kind === 'unread') {
        return {
          failed: `the test report ${shown} of module "${name}" cannot be read: ${text.reason}`,
        };
      }
      const parsed = testReport.format === 'tap' ? parseTap(text.text) : parseJunit(text.text);
      if (!parsed.readable) {
        const format = testReport.format === 'tap' ? 'TAP' : 'JUnit XML';
        return {
          failed: `the test report ${shown} of module "${name}" is not ${format}: ${parsed.reason}`,
        };
      }
      read.push({ ...parsed.report, module: name });
    }
    return { reports: read };
  };
