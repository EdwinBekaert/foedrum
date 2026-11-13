// `npm run worktrees:clean`: removes worktrees under .claude/worktrees/ and local branches that
// are merged into origin/main and whose remote branch GitHub has deleted, and records under
// .git/worktrees/ that git no longer lists or whose folder is gone, wherever it was.
// worktrees-clean/core.ts decides; this shell gathers the facts and carries out the plan (ADR 0021).
// With --session-start (the SessionStart hook) it runs only in the main checkout. It never fails.

import { readdir, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { errorCode } from '../src/platform/errors.ts';
import { pathInside, samePath } from '../src/platform/paths.ts';
import { isPidAlive, stopOnSignals } from '../src/platform/processes.ts';
import { removeTree } from '../src/platform/remove.ts';
import { type GitOptions, runGit as runFoedrumGit } from '../src/workspace/git.ts';
import { deleteOldFiles, NODE_FILES, type TemporaryFilesIo } from '../src/workspace/old-files.ts';
import { parseWorktreeList } from '../src/workspace/worktree-list.ts';
import { readRecords } from '../src/workspace/worktree-records.ts';
import {
  folderState,
  gitThrough,
  noRepositoryCommands,
  type OkGitResult,
  removeWorktree,
} from '../src/workspace/worktree-removal-git.ts';
import {
  type Action,
  type Facts,
  type FolderFact,
  plan,
  shouldRun,
} from './worktrees-clean/core.ts';

export type Git = (cwd: string, args: string[], options?: GitOptions) => Promise<OkGitResult>;

export { gitThrough };

// Foedrum's git never prompts and, at its deadline (60 s by default), kills git with every
// process git started, such as a credential helper of a stalled fetch (#12).
export const runGit: Git = gitThrough(runFoedrumGit);

// How old a file in the main checkout's .foedrum/tmp must be before it goes (ADR 0389).
const TWO_DAYS = 2 * 86_400_000;

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');

// The output of a git call, or an error naming it when the call failed.
const succeed = async (result: Promise<OkGitResult>, what = ''): Promise<string> => {
  const { ok, stdout, stderr } = await result;
  if (!ok) throw new Error(`${what && `git ${what} failed: `}${lines(stderr)[0] ?? 'git failed'}`);
  return stdout;
};

const mainCheckoutOf = async (git: Git, cwd: string): Promise<string | undefined> => {
  const result = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = result.stdout.trim();
  return result.ok && /[\\/]\.git$/.test(commonDir) ? dirname(commonDir) : undefined;
};

// Whether anything under `path`, at any depth, is not a folder; a folder it cannot read counts.
const holdsFiles = async (path: string): Promise<boolean> => {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return true;
  for (const entry of entries) {
    if (!entry.isDirectory() || (await holdsFiles(join(path, entry.name)))) return true;
  }
  return false;
};

// The folders directly under .claude/worktrees/, none when it is not there.
const foldersOf = async (root: string, listed: string[]): Promise<FolderFact[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  });
  const folders: FolderFact[] = [];
  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    const path = join(root, entry.name);
    const isListed = listed.some((worktree) => samePath(worktree, path));
    folders.push({ name: entry.name, path, listed: isListed, holdsFiles: await holdsFiles(path) });
  }
  return folders;
};

// Removes an empty folder from the bottom up with rmdir, so a file that arrived meanwhile stops it.
const removeEmptyFolder = async (path: string): Promise<void> => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyFolder(join(path, entry.name));
  }
  await rmdir(path);
};

// The facts for the core, and each branch's tip for deleting it only while it is still there.
// It throws when a query fails: an incomplete list would make checked-out branches look free.
type Gathered = Facts & { tips: Map<string, string> };

const gatherFacts = async (git: Git, main: string): Promise<Gathered> => {
  const root = join(main, '.claude', 'worktrees');
  const records = await readRecords(join(main, '.git'));
  const listed = await succeed(
    git(main, ['worktree', 'list', '--porcelain', '-z']),
    'worktree list',
  );
  const worktrees = [];
  for (const { path, branch, lockReason } of parseWorktreeList(listed)) {
    const inside = pathInside(root, path);
    const record = records.find(
      ({ folder }) => folder !== undefined && samePath(folder, path),
    )?.dir;
    const state = inside === undefined ? 'unchecked' : await folderState(git, main, path, record);
    worktrees.push({ path, inside, branch, lockReason, state, record });
  }
  // lstrip=2, not :short, which git disambiguates (heads/<name> next to a tag of that name).
  const fields = '%(refname:lstrip=2)%00%(objectname)%00%(upstream:lstrip=2)%00%(upstream:track)';
  const heads = await succeed(
    git(main, ['for-each-ref', `--format=${fields}`, 'refs/heads']),
    'for-each-ref',
  );
  const mergedArgs = ['for-each-ref', '--format=%(refname:lstrip=2)', '--merged=origin/main'];
  const merged = new Set(
    lines(await succeed(git(main, [...mergedArgs, 'refs/heads']), 'for-each-ref')),
  );
  const tips = new Map<string, string>();
  const branches = lines(heads).map((line) => {
    const [name = '', tip = '', upstream = '', track = ''] = line.split('\0');
    tips.set(name, tip);
    return {
      name,
      merged: merged.has(name),
      upstream: upstream || undefined,
      upstreamGone: track === '[gone]',
    };
  });
  const folders = await foldersOf(
    root,
    worktrees.map(({ path }) => path),
  );
  return { worktrees, branches, records, folders, tips };
};

// Carries out one action and returns what it did; throws when it could not.
const carryOut = async (
  git: Git,
  main: string,
  tips: Map<string, string>,
  action: Action,
): Promise<string> => {
  switch (action.kind) {
    case 'remove':
      if (action.unlock) await git(main, ['worktree', 'unlock', action.path]);
      await removeWorktree(git, main, action);
      return `removed worktree ${action.label}`;
    case 'finish':
      await removeWorktree(git, main, action);
      return `finished removing worktree ${action.label}: its .git file was gone`;
    case 'prune':
      await removeWorktree(git, main, action);
      return `pruned stale worktree ${action.label}: folder is gone`;
    case 'drop-record':
      await removeTree(action.record);
      return `removed stale worktree record ${action.label}: ${action.reason}`;
    case 'remove-empty-folder':
      await removeEmptyFolder(action.path);
      return `removed empty folder ${action.label}`;
    case 'delete-branch': {
      // `git branch -d` would check against the main checkout's own main, which is usually
      // behind. Check the tip against origin/main instead, and delete the branch only while it
      // still points at that tip; its config section goes too, as with -d.
      const tip = tips.get(action.branch) ?? '';
      await succeed(git(main, ['merge-base', '--is-ancestor', tip, 'origin/main']));
      await succeed(git(main, ['update-ref', '-d', `refs/heads/${action.branch}`, tip]));
      await git(main, ['config', '--remove-section', `branch.${action.branch}`]);
      return `deleted branch ${action.branch}`;
    }
    default: {
      const unknown: never = action;
      throw new Error(`unknown action ${JSON.stringify(unknown)}`);
    }
  }
};

// One line per removed or kept item, with the reason.
export const cleanWorktrees = async (
  cwd: string,
  git: Git = runGit,
  alive: (pid: number) => boolean = isPidAlive,
  temporary: { files: TemporaryFilesIo; now: () => number } = { files: NODE_FILES, now: Date.now },
): Promise<string[]> => {
  const main = await mainCheckoutOf(git, cwd);
  if (main === undefined) return ['skipped: not inside a git repository'];
  // Before the fetch, so a failed fetch still clears it (ADR 0389).
  const tmp = join(main, '.foedrum', 'tmp');
  const { deleted, left } = await deleteOldFiles(temporary.files, tmp, temporary.now() - TWO_DAYS);
  const cleared = `files deleted from .foedrum/tmp, older than 2 days: ${deleted}, left: ${left}`;
  // fetch reads the main checkout's index, and would run its core.fsmonitor command.
  const fetched = await git(main, ['fetch', '--prune', '--quiet', 'origin'], {
    config: noRepositoryCommands,
  });
  if (!fetched.ok) {
    return [cleared, `skipped: git fetch --prune origin failed: ${fetched.stderr.trim()}`];
  }
  let facts: Gathered;
  try {
    facts = await gatherFacts(git, main);
  } catch (error) {
    return [cleared, `skipped: ${(error as Error).message}`];
  }
  const { actions, kept } = plan(facts, alive);
  const done = [cleared, ...kept];
  for (const action of actions) {
    const steps: Action[] = [action];
    if ('branch' in action && action.kind !== 'delete-branch' && action.branch !== undefined) {
      steps.push({ kind: 'delete-branch', branch: action.branch });
    }
    for (const step of steps) {
      try {
        done.push(await carryOut(git, main, facts.tips, step));
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
    const sessionStart = values['session-start'] === true;
    const cwd = (sessionStart && process.env.CLAUDE_PROJECT_DIR) || process.cwd();
    // Outside Windows git leads a process group of its own, which a Ctrl+C does not reach.
    const signal = stopOnSignals();
    const git: Git = (dir, gitArgs, options) => runGit(dir, gitArgs, { ...options, signal });
    const args = ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'];
    const dirs = await git(cwd, args);
    const [gitDir, commonDir] = lines(dirs.stdout);
    const known = dirs.ok && gitDir !== undefined && commonDir !== undefined;
    if (shouldRun(sessionStart, known ? { gitDir, commonDir } : undefined)) {
      for (const line of await cleanWorktrees(cwd, git)) console.log(`worktrees:clean: ${line}`);
    }
  } catch (error) {
    console.error(`worktrees:clean failed: ${String(error)}`);
  }
}
