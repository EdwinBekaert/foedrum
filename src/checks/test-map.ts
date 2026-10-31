// The test map (ADR 0274): where each module of a target repository has its code, its tests and its
// reports, read from `.foedrum/test-map.jsonc` at a commit of the clone, or from the Brewery for a
// repository whose map it keeps (ADR 0018). The base's map governs every module it lists; a batch's
// map may only add. Repository content, so untrusted input (ADR 0041).

import type { TestMap, TestMapModule } from '../schemas/test-map.ts';
import type { Git } from '../workspace/git.ts';

/** Where a target repository keeps its test map. */
export const TEST_MAP_PATH = '.foedrum/test-map.jsonc';

/** A test map as it was read: none, the map, or why it could not be. */
export type MapRead =
  | { kind: 'none' }
  | { kind: 'map'; map: TestMap }
  | { kind: 'unreadable'; reason: string };

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/** Reads the text of a test map: a syntax or schema error is a reason, never no map. */
export const readTestMap = (_text: string): MapRead => notImplemented();

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

/** Reads a repository's test map at a commit, from where it is kept. */
export const testMaps =
  (_sources: TestMapSources): ReadTestMapAt =>
  () =>
    Promise.resolve(notImplemented());

/** A module of the effective map, and whether only the batch's map lists it. */
export interface EffectiveModule {
  module: TestMapModule;
  added: boolean;
}

/**
 * The effective map of a step: the base's modules as the base lists them, then the modules only
 * the batch's map adds. A base module drops out only when the batch deleted every file the base had
 * under its code and test areas.
 */
export const effectiveMap = (
  _base: TestMap | undefined,
  _batch: TestMap | undefined,
  _files: { atBase: readonly string[]; deleted: readonly string[] },
  _foldCase: boolean,
): EffectiveModule[] => notImplemented();

/** The module and area that read `path`: the base's modules first. */
export const areaOf = (
  _modules: readonly EffectiveModule[],
  _path: string,
  _foldCase: boolean,
): { module: string; area: 'code' | 'tests' } | undefined => notImplemented();

/** The modules only the batch's map lists, with `coverage: none`, for the status comment. */
export const addedUnmeasured = (_base: MapRead, _batch: MapRead): string[] => notImplemented();

/** The files a report's file or folder pattern names in the worktree `root`, or why not. */
export const reportPaths = (
  _pattern: string,
  _root: string,
): { paths: string[] } | { refused: string } => notImplemented();

/** A repository's sensitive paths with its test map's, when the repository keeps it (ADR 0201). */
export const sensitivePathsOf = (_repository: {
  sensitivePaths?: readonly string[];
  testMap?: 'repo' | 'brewery';
}): string[] => notImplemented();
