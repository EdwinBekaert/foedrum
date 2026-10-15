// `npm run worktrees:clean`: removes Claude Code worktrees under .claude/worktrees/ and local
// branches whose work is merged into origin/main, and deletes their remote branches.

import type { RemoveTreeOptions } from '../src/platform/remove.ts';

export interface CleanOptions {
  // Any directory of the repository; the main checkout is found from it.
  cwd: string;
  isPidAlive?: (pid: number) => boolean;
  remove?: RemoveTreeOptions;
}

// One line per removed or kept item, with the reason.
export const cleanWorktrees = async (_options: CleanOptions): Promise<string[]> => {
  throw new Error('not implemented');
};
