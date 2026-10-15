// `npm run worktrees:clean`: removes worktrees under .claude/worktrees/ and local branches that
// are merged into origin/main and whose remote branch GitHub has deleted, and records under
// .git/worktrees/ that git no longer lists or whose folder is gone, wherever it was.
// worktrees-clean/core.ts decides; this shell gathers the facts and carries out the plan (ADR 0021).
// With --session-start (the SessionStart hook) it runs only in the main checkout. It never fails.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathInside, samePath } from '../src/platform/paths.ts';
import { isPidAlive, stopOnSignals } from '../src/platform/processes.ts';
import { clearReadOnly, removeTree } from '../src/platform/remove.ts';
import {
  type GitOptions,
  runGit as runFoedrumGit,
  type Git as WorkspaceGit,
} from '../src/workspace/git.ts';
import {
  type Action,
  type Facts,
  type FolderState,
  plan,
  shouldRun,
} from './worktrees-clean/core.ts';
import { parseWorktreeList } from './worktrees-clean/porcelain.ts';
import { readRecords } from './worktrees-clean/records.ts';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type Git = (cwd: string, args: string[], options?: GitOptions) => Promise<GitResult>;

// The cleanup's git on top of Foedrum's, with success as a flag.
export const gitThrough =
  (run: WorkspaceGit): Git =>
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

// Foedrum's git never prompts and, at its deadline (60 s by default), kills git with every
// process git started, such as a credential helper of a stalled fetch (#12).
export const runGit: Git = gitThrough(runFoedrumGit);

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');

// The output of a git call, or an error naming it when the call failed.
const succeed = async (result: Promise<GitResult>, what = ''): Promise<string> => {
  const { ok, stdout, stderr } = await result;
  if (!ok) throw new Error(`${what && `git ${what} failed: `}${lines(stderr)[0] ?? 'git failed'}`);
  return stdout;
};

const mainCheckoutOf = async (git: Git, cwd: string): Promise<string | undefined> => {
  const result = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = result.stdout.trim();
  return result.ok && /[\\/]\.git$/.test(commonDir) ? dirname(commonDir) : undefined;
};

const folderState = async (git: Git, path: string): Promise<FolderState> => {
  if (!existsSync(path)) return 'gone';
  if (!existsSync(join(path, '.git'))) return 'no-git';
  const status = await git(path, ['status', '--porcelain']);
  return status.ok && status.stdout.trim() === '' ? 'clean' : 'dirty';
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
    const state = inside === undefined ? 'unchecked' : await folderState(git, path);
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
  return { worktrees, branches, records, tips };
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
      for (const path of [action.path, action.record]) {
        if (path !== undefined) await clearReadOnly(path).catch(() => undefined);
      }
      if (action.unlock) await git(main, ['worktree', 'unlock', action.path]);
      try {
        await succeed(git(main, ['worktree', 'remove', action.path]));
      } catch (error) {
        // git deletes the .git file and the record even when it fails on a busy file, and no
        // later run would see the folder again; with the .git file still there, it refused.
        if (existsSync(join(action.path, '.git'))) throw error;
        await removeTree(action.path);
        if (action.record !== undefined) await removeTree(action.record);
      }
      return `removed worktree ${action.label}`;
    case 'finish':
      await removeTree(action.path);
      await removeTree(action.record);
      return `finished removing worktree ${action.label}: its .git file was gone`;
    case 'prune':
      await removeTree(action.record);
      return `pruned stale worktree ${action.label}: folder is gone`;
    case 'drop-record':
      await removeTree(action.record);
      return `removed stale worktree record ${action.label}: ${action.reason}`;
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
): Promise<string[]> => {
  const main = await mainCheckoutOf(git, cwd);
  if (main === undefined) return ['skipped: not inside a git repository'];
  const fetched = await git(main, ['fetch', '--prune', '--quiet', 'origin']);
  if (!fetched.ok) return [`skipped: git fetch --prune origin failed: ${fetched.stderr.trim()}`];
  let facts: Gathered;
  try {
    facts = await gatherFacts(git, main);
  } catch (error) {
    return [`skipped: ${(error as Error).message}`];
  }
  const { actions, kept } = plan(facts, alive);
  const done = [...kept];
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
