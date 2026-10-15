// `npm run worktrees:clean`: removes worktrees under .claude/worktrees/ and local branches that
// are merged into origin/main and whose remote branch GitHub has deleted. worktrees-clean/core.ts
// decides; this shell gathers the facts from git and carries out the plan (ADR 0021).
// With --session-start (the SessionStart hook) it runs only in the main checkout. It never fails.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathInside, samePath } from '../src/platform/paths.ts';
import { clearReadOnly, removeTree } from '../src/platform/remove.ts';
import { type Action, type Facts, type FolderState, plan } from './worktrees-clean/core.ts';
import { parseWorktreeList } from './worktrees-clean/porcelain.ts';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type Git = (cwd: string, args: string[]) => Promise<GitResult>;

const runGit: Git = (cwd, args) =>
  new Promise((done) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const options = { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true, env } as const;
    execFile('git', args, options, (error, stdout, stderr) =>
      done({ ok: error === null, stdout, stderr: stderr || (error?.message ?? '') }),
    );
  });

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const mainCheckoutOf = async (git: Git, cwd: string): Promise<string | undefined> => {
  const result = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = result.stdout.trim();
  return result.ok && /[\\/]\.git$/.test(commonDir) ? dirname(commonDir) : undefined;
};

// Records under .git/worktrees/ with the folder each points at; a relative gitdir
// (worktree.useRelativePaths) is relative to the record.
const listRecords = async (main: string): Promise<{ dir: string; folder: string }[]> => {
  const root = join(main, '.git', 'worktrees');
  const records = [];
  for (const name of await readdir(root).catch(() => [])) {
    const gitdir = await readFile(join(root, name, 'gitdir'), 'utf8').catch(() => '');
    const dir = join(root, name);
    if (gitdir.trim() !== '') records.push({ dir, folder: dirname(resolve(dir, gitdir.trim())) });
  }
  return records;
};

const folderState = async (git: Git, path: string): Promise<FolderState> => {
  if (!existsSync(path)) return 'gone';
  if (!existsSync(join(path, '.git'))) return 'no-git';
  const status = await git(path, ['status', '--porcelain']);
  return status.ok && status.stdout.trim() === '' ? 'clean' : 'dirty';
};

export const gatherFacts = async (git: Git, main: string): Promise<Facts> => {
  const root = join(main, '.claude', 'worktrees');
  const records = await listRecords(main);
  const listed = await git(main, ['worktree', 'list', '--porcelain', '-z']);
  const worktrees = [];
  for (const { path, branch, lockReason } of parseWorktreeList(listed.stdout)) {
    const inside = pathInside(root, path);
    const record = records.find(({ folder }) => samePath(folder, path))?.dir;
    const state = inside === undefined ? 'dirty' : await folderState(git, path);
    worktrees.push({ path, inside, branch, lockReason, state, record });
  }
  const format = '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)';
  const heads = await git(main, ['for-each-ref', format, 'refs/heads']);
  const mergedArgs = ['for-each-ref', '--format=%(refname:short)', '--merged=origin/main'];
  const merged = new Set(lines((await git(main, [...mergedArgs, 'refs/heads'])).stdout));
  const branches = lines(heads.stdout).map((line) => {
    const [name = '', upstream = '', track = ''] = line.split('\0');
    return {
      name,
      merged: merged.has(name),
      upstream: upstream || undefined,
      upstreamGone: track === '[gone]',
    };
  });
  return { worktrees, branches };
};

const succeed = async (result: Promise<GitResult>): Promise<void> => {
  const { ok, stderr } = await result;
  if (!ok) throw new Error(lines(stderr)[0] ?? 'git failed');
};

// Carries out one action and returns what it did; throws when it could not.
const carryOut = async (git: Git, main: string, action: Action): Promise<string> => {
  switch (action.kind) {
    case 'remove':
      for (const path of [action.path, action.record]) {
        if (path !== undefined) await clearReadOnly(path).catch(() => undefined);
      }
      if (action.unlock) await git(main, ['worktree', 'unlock', action.path]);
      await succeed(git(main, ['worktree', 'remove', action.path]));
      return `removed worktree ${action.label}`;
    case 'finish':
      await removeTree(action.path);
      await removeTree(action.record);
      return `finished removing worktree ${action.label}: its .git file was gone`;
    case 'prune':
      await removeTree(action.record);
      return `pruned stale worktree ${action.label}: folder is gone`;
    case 'delete-branch':
      // `git branch -d` checks against the upstream, or HEAD without one, and the main
      // checkout's own main is usually behind; origin/main is what made it a candidate.
      await git(main, ['branch', '--set-upstream-to=origin/main', action.branch]);
      await succeed(git(main, ['branch', '-d', action.branch]));
      return `deleted branch ${action.branch}`;
    default: {
      const unknown: never = action;
      throw new Error(`unknown action ${JSON.stringify(unknown)}`);
    }
  }
};

// One line per removed or kept item, with the reason.
export const cleanWorktrees = async (cwd: string, git: Git = runGit): Promise<string[]> => {
  const main = await mainCheckoutOf(git, cwd);
  if (main === undefined) return ['skipped: not inside a git repository'];
  const fetched = await git(main, ['fetch', '--prune', '--quiet', 'origin']);
  if (!fetched.ok) return [`skipped: git fetch --prune origin failed: ${fetched.stderr.trim()}`];
  const { actions, kept } = plan(await gatherFacts(git, main), isPidAlive);
  const done = [...kept];
  for (const action of actions) {
    const steps: Action[] = [action];
    if (action.kind !== 'delete-branch' && action.branch !== undefined) {
      steps.push({ kind: 'delete-branch', branch: action.branch });
    }
    for (const step of steps) {
      try {
        done.push(await carryOut(git, main, step));
      } catch (error) {
        const item = step.kind === 'delete-branch' ? `branch ${step.branch}` : step.label;
        done.push(`could not clean ${item}: ${(error as Error).message}`);
        break;
      }
    }
  }
  return done;
};

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { 'session-start': { type: 'boolean' } } });
    const cwd = (values['session-start'] && process.env.CLAUDE_PROJECT_DIR) || process.cwd();
    const main = await mainCheckoutOf(runGit, cwd);
    if (!values['session-start'] || (main !== undefined && samePath(main, cwd))) {
      for (const line of await cleanWorktrees(cwd)) console.log(`worktrees:clean: ${line}`);
    }
  } catch (error) {
    console.error(`worktrees:clean failed: ${String(error)}`);
  }
}
