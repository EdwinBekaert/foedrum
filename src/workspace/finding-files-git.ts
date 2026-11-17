// The files a Taster's findings cite, read at the commit it reviewed (ADR 0421), the shell: `git
// ls-tree` and `git cat-file` in the clone, never the worktree, which the brewer can write. Git runs
// only through the injected `Git`, so unit tests pass a fake one (ADR 0021).

import type { ReadFiles } from '../engine/finding-places.ts';
import type { Git } from './git.ts';

export const readFilesAt =
  (_shared: Git): ReadFiles =>
  async () => {
    throw new Error('not implemented');
  };
