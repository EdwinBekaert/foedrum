// Carries out what worktree-removal.ts decides, and gathers the folder state it decides from.
// Shared by the worktree cleanup and the attempt worktree manager (ADR 0021).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearReadOnly, removeTree } from '../platform/remove.ts';
import type { Git as WorkspaceGit } from './git.ts';
import type { FolderState, Removal } from './worktree-removal.ts';

export interface OkGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** git with success as a flag, and a reason on every failure. */
export type OkGit = (cwd: string, args: string[]) => Promise<OkGitResult>;

// Foedrum's git with success as a flag.
export const gitThrough =
  (run: WorkspaceGit): ((...args: Parameters<WorkspaceGit>) => Promise<OkGitResult>) =>
  async (cwd, args, options) => {
    const { code, stdout, stderr } = await run(cwd, args, options);
    // A failure is printed with its reason, and git does not always give one.
    const command = `git ${args[0] ?? ''}`;
    const reason =
      code === 0 || stderr !== ''
        ? stderr
        : code === null
          ? `${command} ended without an exit code`
          : `${command} exited with code ${code}`;
    return { ok: code === 0, stdout, stderr: reason };
  };

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');

/** The state of a worktree folder that git lists. */
export const folderState = async (git: OkGit, path: string): Promise<FolderState> => {
  if (!existsSync(path)) return 'gone';
  if (!existsSync(join(path, '.git'))) return 'no-git';
  const status = await git(path, ['status', '--porcelain']);
  return status.ok && status.stdout.trim() === '' ? 'clean' : 'dirty';
};

/** Removes a worktree of the repository at `main`; throws, with git's reason, when it cannot. */
export const removeWorktree = async (git: OkGit, main: string, removal: Removal) => {
  switch (removal.kind) {
    case 'remove': {
      for (const path of [removal.path, removal.record]) {
        if (path !== undefined) await clearReadOnly(path).catch(() => undefined);
      }
      const removed = await git(main, ['worktree', 'remove', removal.path]);
      if (removed.ok) return;
      // git deletes the .git file and the record even when it fails on a busy file, and no
      // later run would see the folder again; with the .git file still there, it refused.
      if (existsSync(join(removal.path, '.git'))) {
        throw new Error(lines(removed.stderr)[0] ?? 'git failed');
      }
      await removeTree(removal.path);
      if (removal.record !== undefined) await removeTree(removal.record);
      return;
    }
    case 'finish':
      await removeTree(removal.path);
      await removeTree(removal.record);
      return;
    case 'prune':
      await removeTree(removal.record);
      return;
    default: {
      const unknown: never = removal;
      throw new Error(`unknown removal ${JSON.stringify(unknown)}`);
    }
  }
};
