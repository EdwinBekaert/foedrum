// Carries out what worktree-removal.ts decides, and gathers the folder state it decides from.
// Shared by the worktree cleanup and the attempt worktree manager (ADR 0021).

import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { clearReadOnly, errorCode, removeTree } from '../platform/remove.ts';
import type { GitOptions, Git as WorkspaceGit } from './git.ts';
import type { FolderState, Removal } from './worktree-removal.ts';

export interface OkGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** git with success as a flag, and a reason on every failure. */
export type OkGit = (cwd: string, args: string[], options?: GitOptions) => Promise<OkGitResult>;

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

/**
 * git status of the worktree at `path`, run in `main` against `record`, its record under the
 * clone: never by discovery from the folder, whose .git file a brewer can point at a git folder
 * of its own, with a core.fsmonitor command in its configuration (#263, ADR 0095).
 */
export const statusOf = (git: OkGit, main: string, record: string, path: string) =>
  git(main, [`--git-dir=${record}`, `--work-tree=${path}`, 'status', '--porcelain'], {
    config: { 'core.fsmonitor': 'false', 'core.hooksPath': devNull },
  });

/**
 * The state of a worktree folder that git lists; `unchecked` when the repository at `main` has
 * no record of it, which keeps it.
 */
export const folderState = async (
  git: OkGit,
  main: string,
  path: string,
  record: string | undefined,
): Promise<FolderState> => {
  if (!existsSync(path)) return 'gone';
  if (!existsSync(join(path, '.git'))) return 'no-git';
  if (record === undefined) return 'unchecked';
  const status = await statusOf(git, main, record, path);
  return status.ok && status.stdout.trim() === '' ? 'clean' : 'dirty';
};

// A worktree's untracked out doc, its only change when git listed it (ADR 0081). A folder that
// took its place since stays, and git worktree remove refuses it as any other change.
const removeOutDoc = async (file: string): Promise<void> => {
  const found = await lstat(file).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (found !== undefined && !found.isDirectory()) await removeTree(file);
};

/** Removes a worktree of the repository at `main`; throws, with git's reason, when it cannot. */
export const removeWorktree = async (git: OkGit, main: string, removal: Removal) => {
  switch (removal.kind) {
    case 'remove': {
      if (removal.outDoc !== undefined) await removeOutDoc(join(removal.path, removal.outDoc));
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
