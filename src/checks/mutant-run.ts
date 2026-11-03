// Brett's mutants run around the brewer runner (ADR 0017, ADR 0040, ADR 0313): once a Brett
// attempt's session succeeded, the engine checks each mutant against the batch's change, runs the
// test check once in a scratch tree of the attempt's commit as the baseline, and once per valid
// mutant in a fresh scratch tree with the mutant's edit, and records each mutant's verdict on the
// attempt's end. The attempt succeeds whatever the verdicts.

import type { AttemptRef } from '../engine/attempt-key.ts';
import type { BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { Git } from '../workspace/git.ts';
import type { CommitTree } from '../workspace/merge-tree-git.ts';
import type { TestRun } from './check-runner.ts';
import type { ReadTestMapAt } from './test-map.ts';

export interface MutantRunOptions {
  runner: BrewerRunner;
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** Whether attempt `ref`'s brewer writes the out doc schema `mutants` (ADR 0311). */
  mutates: (ref: AttemptRef) => boolean;
  git: Git;
  /** The clone a repository's attempt worktrees are added to, where git reads the change. */
  clone: (repo: string) => string;
  /** A repository's test map by commit (ADR 0274). */
  testMap: ReadTestMapAt;
  /** A scratch worktree of a commit of a repository (ADR 0313). */
  tree: (repo: string) => CommitTree;
  /** The test check run in a scratch tree (ADR 0313). */
  testRun: TestRun;
  /** Whose file system's case rule the map's globs are matched by. Default this process's. */
  platform?: NodeJS.Platform;
  /** Default the system clock. */
  clock?: () => Date;
}

export function mutated(options: MutantRunOptions): BrewerRunner {
  return options.runner;
}
