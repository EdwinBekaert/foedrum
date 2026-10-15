// `npm run worktrees:clean`: removes Claude Code worktrees under .claude/worktrees/ and local
// branches whose work is merged into origin/main and whose remote branch is gone. It never
// deletes remote branches: GitHub deletes head branches on merge.
// Pull requests are merged with a merge commit, so "merged" is exact: the branch tip is an
// ancestor of origin/main but not on its first-parent line. A branch started from main with no
// commits of its own is therefore never merged; one started from another branch that is merged
// counts as merged, and holds no work of its own. No GitHub API call is needed.
//
// It never touches the main checkout, a worktree outside .claude/worktrees/ (or nested inside
// another one), the current worktree, a worktree with uncommitted or untracked changes, or one
// locked by a live Claude Code session. Branches are deleted with `git branch -d`, never -D.
// It never prompts and never fails: anything it cannot remove is reported and left alone.
//
// With --session-start (the SessionStart hook in .claude/settings.json) it runs only when
// CLAUDE_PROJECT_DIR is the main checkout, so a session inside a worktree starts untouched.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathInside, samePath } from '../src/platform/paths.ts';
import { clearReadOnly, type RemoveTreeOptions, removeTree } from '../src/platform/remove.ts';

export interface CleanOptions {
  // Any directory of the repository; the main checkout is found from it.
  cwd: string;
  isPidAlive?: (pid: number) => boolean;
  remove?: RemoveTreeOptions;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface Worktree {
  path: string;
  branch: string | undefined;
  lockReason: string | undefined;
}

interface Context {
  main: string;
  // The worktree the command runs in; never removed.
  current: string;
  // origin/main, or whatever origin/HEAD points at.
  base: string;
  // The commits on the base's first-parent line: main's own history, never a merged branch tip.
  firstParents: Set<string>;
  isPidAlive: (pid: number) => boolean;
  remove: RemoveTreeOptions;
  lines: string[];
}

const GIT_TIMEOUT_MS = 60_000;
// The lock reason Claude Code writes for a session's worktree.
const SESSION_LOCK = /^claude session .+ \(pid (\d+)\)$/;

const runGit = (cwd: string, args: string[]): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        // rev-list --first-parent prints one 41-byte line per commit of main.
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        // LC_ALL=C keeps git's messages in English, so a part-way failure can be recognised.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) =>
        resolve({ ok: error === null, stdout, stderr: stderr || (error?.message ?? '') }),
    );
  });

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? 'no output';

const errorText = (error: unknown): string =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : String(error);

const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errorText(error) === 'EPERM';
  }
};

const mainCheckoutOf = async (cwd: string): Promise<string | undefined> => {
  const result = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!result.ok) return undefined;
  const commonDir = result.stdout.trim();
  return /[\\/]\.git$/.test(commonDir) ? dirname(commonDir) : undefined;
};

// Resolves symbolic links, junctions and subst drives, so both sides of a comparison agree.
const realPath = (path: string): Promise<string> => realpath(path).catch(() => path);

export const isMainCheckout = async (dir: string): Promise<boolean> => {
  const main = await mainCheckoutOf(dir);
  return main !== undefined && samePath(await realPath(main), await realPath(dir));
};

// `git worktree list --porcelain -z`: records of NUL-terminated fields, ended by an empty one.
const parseWorktrees = (output: string): Worktree[] => {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), branch: undefined, lockReason: undefined };
      worktrees.push(current);
    } else if (current !== undefined && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    } else if (current !== undefined && (field === 'locked' || field.startsWith('locked '))) {
      current.lockReason = field.slice('locked '.length);
    }
  }
  return worktrees;
};

const listWorktrees = async (ctx: Context): Promise<Worktree[]> => {
  const listed = await runGit(ctx.main, ['worktree', 'list', '--porcelain', '-z']);
  return listed.ok ? parseWorktrees(listed.stdout) : [];
};

const defaultBranch = (ctx: Context): string => ctx.base.replace(/^origin\//, '');

// Merged means an ancestor of the base that is not on its first-parent line: a merged pull
// request's tip is the second parent of its merge commit, while a branch started from main
// with no commits of its own points at a commit of main itself.
const isMerged = async (ctx: Context, branch: string): Promise<boolean> => {
  const ref = `refs/heads/${branch}^{commit}`;
  const tip = await runGit(ctx.main, ['rev-parse', '--verify', '--quiet', ref]);
  const sha = tip.stdout.trim();
  if (!tip.ok || ctx.firstParents.has(sha)) return false;
  return (await runGit(ctx.main, ['merge-base', '--is-ancestor', sha, `refs/remotes/${ctx.base}`]))
    .ok;
};

// Why a merged branch must stay, or undefined when it may go: only once its remote branch is
// gone, as GitHub leaves it after a merge. The repository deletes head branches on merge and
// `git fetch --prune` drops the remote-tracking ref, so a long-lived branch such as develop,
// whose remote branch stays, is never deleted.
const remoteKeepReason = async (ctx: Context, branch: string): Promise<string | undefined> => {
  const upstream = await runGit(ctx.main, [
    'for-each-ref',
    '--format=%(upstream)%00%(upstream:track)',
    `refs/heads/${branch}`,
  ]);
  const [ref = '', track = ''] = upstream.stdout.trim().split('\0');
  if (ref === '') return 'it has no upstream branch';
  return track === '[gone]' ? undefined : 'its remote branch still exists';
};

// Why a lock keeps the worktree, or undefined when there is no lock or its session is gone.
const lockKeepReason = (ctx: Context, lockReason: string | undefined): string | undefined => {
  if (lockReason === undefined) return undefined;
  const pid = SESSION_LOCK.exec(lockReason)?.[1];
  if (pid === undefined) return `locked: ${lockReason || 'no reason given'}`;
  return ctx.isPidAlive(Number(pid)) ? `locked by a live session (pid ${pid})` : undefined;
};

// Why the worktree must stay, or undefined when it may be removed.
const keepReason = async (
  ctx: Context,
  worktree: Worktree,
  all: Worktree[],
): Promise<string | undefined> => {
  const nested = all.find((other) => pathInside(worktree.path, other.path) !== undefined);
  if (nested !== undefined) return `contains the worktree ${nested.path}`;
  if (samePath(worktree.path, ctx.current)) return 'it is the current worktree';
  if (worktree.branch === undefined) return 'detached HEAD';
  if (worktree.branch === defaultBranch(ctx)) return 'it has the default branch checked out';
  if (!(await isMerged(ctx, worktree.branch))) return `not merged into ${ctx.base}`;
  const remote = await remoteKeepReason(ctx, worktree.branch);
  if (remote !== undefined) return remote;
  const locked = lockKeepReason(ctx, worktree.lockReason);
  if (locked !== undefined) return locked;
  // Without its own .git file, git would run in the main checkout and find nothing to keep.
  const top = await runGit(worktree.path, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !samePath(top.stdout.trim(), worktree.path)) {
    return 'its .git file is missing or broken';
  }
  const status = await runGit(worktree.path, ['status', '--porcelain']);
  if (!status.ok) return `git status failed: ${firstLine(status.stderr)}`;
  if (status.stdout.trim() !== '') return 'it has uncommitted or untracked changes';
  return undefined;
};

interface WorktreeRecord {
  // The record's folder under .git/worktrees/.
  dir: string;
  // The worktree folder it points at, through its `gitdir` file.
  folder: string;
  lockReason: string | undefined;
}

const listRecords = async (ctx: Context): Promise<WorktreeRecord[]> => {
  const records = join(ctx.main, '.git', 'worktrees');
  const result: WorktreeRecord[] = [];
  for (const name of await readdir(records).catch(() => [])) {
    const dir = join(records, name);
    const gitdir = await readFile(join(dir, 'gitdir'), 'utf8').catch(() => '');
    if (gitdir.trim() === '') continue;
    const locked = await readFile(join(dir, 'locked'), 'utf8').catch(() => undefined);
    // With worktree.useRelativePaths the gitdir is relative to the record's folder.
    const folder = dirname(resolve(dir, gitdir.trim()));
    result.push({ dir, folder, lockReason: locked?.trim() });
  }
  return result;
};

const deletePath = async (ctx: Context, path: string, label: string): Promise<boolean> => {
  try {
    await removeTree(path, ctx.remove);
    return true;
  } catch (error) {
    ctx.lines.push(`could not delete ${label} (${path}): ${errorText(error)}`);
    return false;
  }
};

// Removes the worktree's folder and record; false when something stayed behind.
const removeWorktree = async (
  ctx: Context,
  worktree: Worktree,
  label: string,
): Promise<boolean> => {
  const record = (await listRecords(ctx)).find(({ folder }) => samePath(folder, worktree.path));
  for (const path of [worktree.path, record?.dir]) {
    if (path !== undefined) await clearReadOnly(path).catch(() => undefined);
  }
  if (worktree.lockReason !== undefined) {
    await runGit(ctx.main, ['worktree', 'unlock', worktree.path]);
  }
  const removed = await runGit(ctx.main, ['worktree', 'remove', worktree.path]);
  // git checks the worktree before it deletes anything. A refusal leaves it whole; a delete
  // that fails part-way (a busy file on Windows) says "failed to delete", and the rest of the
  // folder, already checked clean above, can go.
  const partWay = /failed to delete/.test(removed.stderr);
  if (!removed.ok && !partWay && existsSync(join(worktree.path, '.git'))) {
    ctx.lines.push(
      `kept worktree ${label}: git worktree remove failed: ${firstLine(removed.stderr)}`,
    );
    return false;
  }
  if (!removed.ok && !(await deletePath(ctx, worktree.path, label))) return false;
  // `git worktree prune`, for this worktree only.
  if (
    record !== undefined &&
    existsSync(record.dir) &&
    !(await deletePath(ctx, record.dir, label))
  ) {
    return false;
  }
  ctx.lines.push(`removed worktree ${label}`);
  return true;
};

const deleteBranch = async (ctx: Context, branch: string): Promise<void> => {
  // `git branch -d` checks the branch against its upstream, or HEAD without one. Pointing it
  // at origin/main makes -d check exactly what made it a candidate, even while the main
  // checkout's own main is behind.
  await runGit(ctx.main, ['branch', `--set-upstream-to=${ctx.base}`, branch]);
  const deleted = await runGit(ctx.main, ['branch', '-d', branch]);
  if (!deleted.ok) {
    ctx.lines.push(`kept branch ${branch}: git branch -d failed: ${firstLine(deleted.stderr)}`);
    return;
  }
  ctx.lines.push(`deleted branch ${branch}`);
};

// `git worktree prune`, limited to records of worktrees anywhere under .claude/worktrees/
// (direct children and scratch trees nested in them) whose folder is gone. Their branches are
// then free, and the branch pass deletes the merged ones.
const pruneStaleRecords = async (ctx: Context): Promise<void> => {
  const root = join(ctx.main, '.claude', 'worktrees');
  for (const record of await listRecords(ctx)) {
    const inside = pathInside(root, record.folder);
    if (inside === undefined || existsSync(record.folder)) continue;
    const label = `.claude/worktrees/${inside}`;
    const locked = lockKeepReason(ctx, record.lockReason);
    if (locked !== undefined) ctx.lines.push(`kept stale worktree ${label}: ${locked}`);
    else if (await deletePath(ctx, record.dir, label)) {
      ctx.lines.push(`pruned stale worktree ${label}: folder is gone`);
    }
  }
};

const cleanClaudeWorktrees = async (ctx: Context): Promise<void> => {
  const root = join(ctx.main, '.claude', 'worktrees');
  const all = await listWorktrees(ctx);
  for (const worktree of all) {
    const inside = pathInside(root, worktree.path);
    // Only direct children of .claude/worktrees/ are candidates.
    if (inside === undefined || inside.includes('/')) continue;
    const label = `.claude/worktrees/${inside}`;
    const reason = await keepReason(ctx, worktree, all);
    if (reason !== undefined) {
      ctx.lines.push(`kept worktree ${label}: ${reason}`);
      continue;
    }
    if ((await removeWorktree(ctx, worktree, label)) && worktree.branch !== undefined) {
      await deleteBranch(ctx, worktree.branch);
    }
  }
};

const cleanBranchesWithoutWorktree = async (ctx: Context): Promise<void> => {
  const checkedOut = new Set((await listWorktrees(ctx)).map((worktree) => worktree.branch));
  const heads = await runGit(ctx.main, ['for-each-ref', '--format=%(refname)', 'refs/heads']);
  const branches = heads.stdout
    .split(/\r?\n/)
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
  for (const branch of branches) {
    if (branch === defaultBranch(ctx) || checkedOut.has(branch)) continue;
    const reason = (await isMerged(ctx, branch))
      ? await remoteKeepReason(ctx, branch)
      : `not merged into ${ctx.base}`;
    if (reason === undefined) await deleteBranch(ctx, branch);
    else ctx.lines.push(`kept branch ${branch}: ${reason}`);
  }
};

// One line per removed or kept item, with the reason.
export const cleanWorktrees = async (options: CleanOptions): Promise<string[]> => {
  const main = await mainCheckoutOf(options.cwd);
  if (main === undefined) return ['skipped: not inside a git repository with a main checkout'];
  const fetched = await runGit(main, ['fetch', '--prune', '--quiet', 'origin']);
  if (!fetched.ok) {
    return [`skipped: git fetch --prune origin failed: ${firstLine(fetched.stderr)}`];
  }
  const top = await runGit(options.cwd, ['rev-parse', '--show-toplevel']);
  const head = await runGit(main, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const base = head.ok ? head.stdout.trim() : 'origin/main';
  const history = await runGit(main, ['rev-list', '--first-parent', `refs/remotes/${base}`]);
  if (!history.ok) {
    return [`skipped: git rev-list ${base} failed: ${firstLine(history.stderr)}`];
  }
  const ctx: Context = {
    main,
    current: top.ok ? top.stdout.trim() : main,
    base,
    firstParents: new Set(history.stdout.split(/\r?\n/).filter((sha) => sha !== '')),
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    remove: options.remove ?? {},
    lines: [],
  };
  await pruneStaleRecords(ctx);
  await cleanClaudeWorktrees(ctx);
  await cleanBranchesWithoutWorktree(ctx);
  return ctx.lines;
};

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { 'session-start': { type: 'boolean' } } });
    const sessionStart = values['session-start'] === true;
    const cwd = sessionStart ? (process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) : process.cwd();
    if (!sessionStart || (await isMainCheckout(cwd))) {
      for (const line of await cleanWorktrees({ cwd })) console.log(`worktrees:clean: ${line}`);
    }
  } catch (error) {
    console.error(`worktrees:clean failed: ${errorText(error)}`);
  }
}
