// Parses `git worktree list --porcelain -z`: NUL-terminated fields, records ended by an empty one.

export interface ListedWorktree {
  path: string;
  branch: string | undefined;
  lockReason: string | undefined;
}

export const parseWorktreeList = (output: string): ListedWorktree[] => {
  const worktrees: ListedWorktree[] = [];
  for (const field of output.split('\0')) {
    const current = worktrees.at(-1);
    if (field.startsWith('worktree ')) {
      worktrees.push({ path: field.slice(9), branch: undefined, lockReason: undefined });
    } else if (current !== undefined && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    } else if (current !== undefined && (field === 'locked' || field.startsWith('locked '))) {
      current.lockReason = field.slice('locked '.length);
    }
  }
  return worktrees;
};
