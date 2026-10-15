// Parses `git worktree list --porcelain -z`.

export interface ListedWorktree {
  path: string;
  branch: string | undefined;
  lockReason: string | undefined;
}

export const parseWorktreeList = (_output: string): ListedWorktree[] => {
  throw new Error('not implemented');
};
