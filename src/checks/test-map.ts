// The test map (ADR 0274): where each module of a target repository has its code, its tests and its
// reports, read from `.foedrum/test-map.jsonc` at a commit of the clone, or from the Brewery for a
// repository whose map it keeps (ADR 0018). The base's map governs every module it lists; a batch's
// map may only add. Repository content, so untrusted input (ADR 0041).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { matchesWithDots } from '../engine/path-globs.ts';
import { pathInside } from '../platform/paths.ts';
import { realPath } from '../platform/real-path.ts';
import { readJsonc } from '../schemas/read.ts';
import { TestMap, type TestMapModule } from '../schemas/test-map.ts';
import type { Git, GitResult } from '../workspace/git.ts';

/** Where a target repository keeps its test map. */
export const TEST_MAP_PATH = '.foedrum/test-map.jsonc';

/** A test map as it was read: none, the map, or why it could not be. */
export type MapRead =
  | { kind: 'none' }
  | { kind: 'map'; map: TestMap }
  | { kind: 'unreadable'; reason: string };

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, '; ');

/** Reads the text of a test map: a syntax or schema error is a reason, never no map. */
export const readTestMap = (text: string): MapRead => {
  const read = readJsonc(text, TestMap);
  return read.valid
    ? { kind: 'map', map: read.value }
    : { kind: 'unreadable', reason: oneLine(read.reason) };
};

/** Where the Brewery keeps the map of `repo`, from its root, for `testMap: "brewery"`. */
export const breweryMapPath = (repo: string): string => `test-maps/${repo.toLowerCase()}.jsonc`;

export interface TestMapSources {
  git: Git;
  /** The clone of a repository, where git reads its commits. */
  clone: (repo: string) => string;
  /** Where a repository's map is kept: in it, or in the Brewery (ADR 0018). */
  keptIn: (repo: string) => 'repo' | 'brewery';
  /** The text of the Brewery's map of a repository, or undefined when it has none. */
  brewery: (repo: string) => string | undefined;
}

/** The test map of a repository at a commit. */
export type ReadTestMapAt = (
  repo: string,
  commit: string,
  signal?: AbortSignal,
) => Promise<MapRead>;

/** A map is a few modules' places: far less than this. */
const MAX_MAP_BYTES = 1024 * 1024;

/** How long one git read of the map may take. */
const MAP_READ_MS = 10_000;

/** Why git could not read the map. */
const gitFailed = (result: GitResult): MapRead => {
  if (result.killed === 'too-much-output') {
    return { kind: 'unreadable', reason: `it is larger than ${MAX_MAP_BYTES} bytes` };
  }
  const last = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);
  const why = last ?? `git exited with ${result.code ?? result.killed ?? 'no code'}`;
  return { kind: 'unreadable', reason: `git could not read it: ${why}` };
};

/**
 * Reads a repository's test map at a commit, from where it is kept: with git in the clone, as
 * committed (a link or a folder at its path is a reason), or the Brewery's, the same at every commit.
 */
export const testMaps =
  ({ git, clone, keptIn, brewery }: TestMapSources): ReadTestMapAt =>
  async (repo, commit, signal) => {
    if (keptIn(repo) === 'brewery') {
      const text = brewery(repo);
      return text === undefined ? { kind: 'none' } : readTestMap(text);
    }
    const cwd = clone(repo);
    const options = {
      timeoutMs: MAP_READ_MS,
      maxOutputBytes: MAX_MAP_BYTES,
      ...(signal === undefined ? {} : { signal }),
    };
    const listed = await git(cwd, ['ls-tree', '-z', commit, '--', TEST_MAP_PATH], options);
    if (listed.code !== 0) return gitFailed(listed);
    const entry = listed.stdout.split('\0').find((line) => line !== '');
    if (entry === undefined) return { kind: 'none' };
    const [, blob] = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry) ?? [];
    if (blob === undefined) {
      return { kind: 'unreadable', reason: `${TEST_MAP_PATH} is not a regular file` };
    }
    const read = await git(cwd, ['cat-file', 'blob', blob], options);
    return read.code === 0 ? readTestMap(read.stdout) : gitFailed(read);
  };

/** A module of the effective map, and whether only the batch's map lists it. */
export interface EffectiveModule {
  module: TestMapModule;
  added: boolean;
}

/** The globs of a module's separate tests: a test project is every file in its folder. */
const testGlobs = ({ tests }: TestMapModule): string[] =>
  'paths' in tests
    ? tests.paths
    : 'projects' in tests
      ? tests.projects.map(({ path }) => `${path}/**`)
      : [];

/** Whether `glob` matches `path`, in either case where the file system does not tell case apart. */
const matches = (path: string, glob: string, foldCase: boolean): boolean =>
  foldCase ? matchesWithDots(path.toLowerCase(), glob.toLowerCase()) : matchesWithDots(path, glob);

const inAreas = (module: TestMapModule, path: string, foldCase: boolean): boolean =>
  [...module.code, ...testGlobs(module)].some((glob) => matches(path, glob, foldCase));

/**
 * The effective map of a step: the base's modules as the base lists them, then the modules only
 * the batch's map adds. A base module drops out only when the batch deleted every file the base had
 * under its code and test areas.
 */
export const effectiveMap = (
  base: TestMap | undefined,
  batch: TestMap | undefined,
  files: { atBase: readonly string[]; deleted: readonly string[] },
  foldCase: boolean,
): EffectiveModule[] => {
  const key = (path: string): string => (foldCase ? path.toLowerCase() : path);
  const deleted = new Set(files.deleted.map(key));
  const kept = (module: TestMapModule): boolean => {
    const had = files.atBase.filter((path) => inAreas(module, path, foldCase));
    return had.length === 0 || !had.every((path) => deleted.has(key(path)));
  };
  const baseModules = base?.modules ?? [];
  // A module the base lists by its name is the base's, as the base lists it, or gone.
  const listed = new Set(baseModules.map(({ name }) => name));
  return [
    ...baseModules.filter(kept).map((module) => ({ module, added: false })),
    ...(batch?.modules ?? [])
      .filter(({ name }) => !listed.has(name))
      .map((module) => ({ module, added: true })),
  ];
};

/** The module and area that read `path`: the base's modules first, a module's tests before its code. */
export const areaOf = (
  modules: readonly EffectiveModule[],
  path: string,
  foldCase: boolean,
): { module: string; area: 'code' | 'tests' } | undefined => {
  for (const { module } of modules) {
    if (testGlobs(module).some((glob) => matches(path, glob, foldCase))) {
      return { module: module.name, area: 'tests' };
    }
    if (module.code.some((glob) => matches(path, glob, foldCase))) {
      return { module: module.name, area: 'code' };
    }
  }
  return undefined;
};

/** The modules only the batch's map lists, with `coverage: none`, for the status comment. */
export const addedUnmeasured = (base: MapRead, batch: MapRead): string[] => {
  if (batch.kind !== 'map' || base.kind === 'unreadable') return [];
  const modules = effectiveMap(
    base.kind === 'map' ? base.map : undefined,
    batch.map,
    { atBase: [], deleted: [] },
    false,
  );
  return modules
    .filter(({ module, added }) => added && module.coverage === 'none')
    .map(({ module }) => module.name);
};

/** The most paths a report's folder pattern may match. */
const MAX_REPORT_PATHS = 64;

/**
 * Whether `name` matches `segment`, whose only wildcard is `*`: its literal parts in order, the
 * first at the start and the last at the end. No regular expression, so a segment a batch's map
 * wrote is matched in time linear in its length for each name.
 */
const matchesSegment = (name: string, segment: string): boolean => {
  const [first = '', ...rest] = segment.split('*');
  const last = rest.pop();
  if (last === undefined) return name === first;
  if (!name.startsWith(first) || name.length < first.length + last.length) return false;
  let at = first.length;
  const end = name.length - last.length;
  for (const part of rest) {
    const found = name.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return name.endsWith(last);
};

/**
 * The files or folders a report's file or folder pattern names in the worktree `root`, each by its
 * real path inside it, or why not: one that leads out of the worktree, or a pattern that matches
 * more than `MAX_REPORT_PATHS`.
 */
export const reportPaths = (
  pattern: string,
  root: string,
): { paths: string[] } | { refused: string } => {
  let found = [root];
  for (const segment of pattern.split('/')) {
    const next: string[] = [];
    for (const folder of found) {
      if (!segment.includes('*')) {
        if (existsSync(join(folder, segment))) next.push(join(folder, segment));
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch {
        // A file, or a folder that cannot be listed, holds no report.
        continue;
      }
      for (const name of names) {
        if (matchesSegment(name, segment)) next.push(join(folder, name));
      }
    }
    if (next.length > MAX_REPORT_PATHS) {
      return { refused: `${pattern} matches more than ${MAX_REPORT_PATHS} paths` };
    }
    found = next;
  }
  try {
    const inside = realPath(root);
    if (found.some((path) => pathInside(inside, realPath(path)) === undefined)) {
      return { refused: `${pattern} leads out of the worktree` };
    }
  } catch (error) {
    return { refused: `${pattern} cannot be resolved: ${(error as Error).message}` };
  }
  return { paths: found };
};

/** A repository's sensitive paths with its test map's, when the repository keeps it (ADR 0201). */
export const sensitivePathsOf = (repository: {
  sensitivePaths?: readonly string[];
  testMap?: 'repo' | 'brewery';
}): string[] => [
  ...(repository.sensitivePaths ?? []),
  ...(repository.testMap === 'brewery' ? [] : [TEST_MAP_PATH]),
];
