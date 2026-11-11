// The red step's test files, for the checks before a brewer's end (ADR 0381): the files the proven
// step's commits added or changed in a test area of the test map, read in the clone as the
// testsUnchanged guard reads them (ADR 0274). None when the batch has no red step, or git or a map
// cannot say: those checks then run no test, and green is still the gate.

import { mergedBase } from '../engine/base-merge.ts';
import type { Batch, State } from '../engine/fold.ts';
import { foldsCase } from '../platform/paths.ts';
import type { TestMap } from '../schemas/test-map.ts';
import { inClone } from '../workspace/clone-git.ts';
import type { Git } from '../workspace/git.ts';
import { readDiff, stepCommits } from './step-commits.ts';
import { effectiveMap, type ReadTestMapAt } from './test-map.ts';
import { guardedFiles } from './tests-unchanged.ts';

export interface RedTestsRead {
  git: Git;
  /** The clone of the batch's repository `repo`, where git reads the commits. */
  clone: string;
  testMap: ReadTestMapAt;
  state: State;
  batch: Batch;
  repo: string;
  /** The step the recipe's red proof proves; undefined without one. */
  of: string | undefined;
  platform: NodeJS.Platform;
}

/** The red step's test files in `repo`, as the repository names them. */
export async function redTestFiles(read: RedTestsRead): Promise<string[]> {
  const { batch, of, repo } = read;
  const proven = of === undefined ? undefined : stepCommits(batch, of);
  if (proven === undefined) return [];
  const diff = await readDiff(inClone(read.git), read.clone, proven);
  if ('error' in diff) return [];
  // The base's map and the map the red step committed, as the guard keeps them (ADR 0274).
  const base = mergedBase(read.state, batch.id) ?? batch.starts?.[repo.toLowerCase()]?.commit;
  const maps: (TestMap | undefined)[] = [];
  for (const commit of [base, proven.to]) {
    const map = commit === undefined ? undefined : await read.testMap(repo, commit);
    maps.push(map?.kind === 'map' ? map.map : undefined);
  }
  const [atBase, atStep] = maps;
  const foldCase = foldsCase(read.platform);
  const modules = effectiveMap(atBase, atStep, { atBase: [], deleted: [] }, foldCase);
  return guardedFiles(diff.files, modules, foldCase);
}
