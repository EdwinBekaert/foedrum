// The paths of a plan read at a commit (ADR 0233), the shell: `git ls-tree` in the clone, which
// reads trees only, so a blob-less clone fetches nothing. Git runs only through the injected
// `Git`, so unit tests pass a fake one (ADR 0021).

import type { ReadPaths } from '../engine/plan-touches.ts';
import type { Git } from './git.ts';

export const readPathsAt =
  (_shared: Git): ReadPaths =>
  async () => {
    throw new Error('not implemented');
  };
