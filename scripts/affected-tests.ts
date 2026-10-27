// `node scripts/affected-tests.ts`: lists the test files the change reaches (ADR 0241), the ones
// `npm run check` runs. The change is the files that differ between the merge base of HEAD with
// origin/main and the working tree, untracked files included. affected-tests/core.ts decides;
// this shell asks git and reads the files (ADR 0021).

import type { OkGit } from '../src/workspace/worktree-removal-git.ts';
import type { Affected } from './affected-tests/core.ts';

export interface ChangeOptions {
  // The checkout's root; git's paths are relative to it.
  cwd: string;
  git: OkGit;
  // A file's text by its absolute path; undefined when it is not there.
  read: (path: string) => Promise<string | undefined>;
}

/** The test files the change in the checkout at cwd reaches. */
export const affectedByChange = async (_options: ChangeOptions): Promise<Affected> => {
  throw new Error('not implemented');
};
