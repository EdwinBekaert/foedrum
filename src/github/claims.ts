// The claim ref of a target-repository issue on GitHub (ADR 0043).

import type { ClaimHost } from '../engine/issue-claims.ts';
import type { GitHubClient } from './client.ts';

/** git's empty tree: every claim commit has it, and no parent. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const githubClaimHost = (_client: GitHubClient): ClaimHost => {
  throw new Error('not implemented');
};
