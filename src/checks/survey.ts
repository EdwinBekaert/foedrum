// The Maltster's survey around the brewer runner (ADR 0282, ADR 0298): before a survey's session
// starts, it reads the test map at the attempt's base and its manifests in the worktree, and ends
// the attempt as succeeded with no session when the map is fresh, or kept by the Brewery, which a
// survey cannot write. After an attempt of a brewer with the testMapOnly guard, it fails the
// attempt when its commits changed anything but the test map.

import type { AttemptRef } from '../engine/attempt-key.ts';
import type { BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { Git } from '../workspace/git.ts';
import type { ReadManifestFreshness, ReadTestMapAt } from './test-map.ts';

export interface SurveyOptions {
  runner: BrewerRunner;
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** Whether attempt `ref` is a survey's: its brewer answers with the out doc schema `survey`. */
  surveys: (ref: AttemptRef) => boolean;
  /** Whether attempt `ref`'s brewer has the testMapOnly guard. */
  mapOnly: (ref: AttemptRef) => boolean;
  /** A repository's test map by commit (ADR 0274). */
  testMap: ReadTestMapAt;
  /** Where a repository's map is kept (ADR 0018). */
  keptIn: (repo: string) => 'repo' | 'brewery';
  /** A map's manifests against a worktree's files (ADR 0282); default git's. */
  manifests?: ReadManifestFreshness;
  git: Git;
  /** The clone a repository's attempt worktrees are added to, where git reads the commits. */
  clone: (repo: string) => string;
  /** Default the system clock. */
  clock?: () => Date;
}

export function surveyed(_options: SurveyOptions): BrewerRunner {
  throw new Error('not implemented');
}
