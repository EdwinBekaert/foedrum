// The attempt worktree manager's shell (ADR 0012, ADR 0029): gathers facts from git and the
// attempts root, and carries out what attempt-worktrees.ts decides. Git runs only through the
// injected `Git`, so unit tests pass a fake one (ADR 0021).

import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { removeStaleIndexLock } from '../platform/index-lock.ts';
import { pathInside, samePath } from '../platform/paths.ts';
import { errorCode, removeTree } from '../platform/remove.ts';
import { type Rename, replaceFile } from '../platform/replace-file.ts';
import {
  type Action,
  type AttemptRef,
  attemptBranch,
  attemptFolder,
  type BatchFolderFact,
  type Claims,
  type ListedFact,
  parseAttemptFolder,
  planClean,
  planWorktree,
  repoFolder,
  type Target,
  worktreeStatus,
} from './attempt-worktrees.ts';
import type { Git, GitOptions, GitResult } from './git.ts';
import { parseWorktreeList } from './worktree-list.ts';
import { readRecords } from './worktree-records.ts';
import type { FolderState } from './worktree-removal.ts';
import { gitThrough, removeWorktree } from './worktree-removal-git.ts';

export interface AttemptWorktreesOptions {
  git: Git;
  /** Foedrum's work root, outside the Brewery checkout (default `~/.foedrum/<brewery>/`). */
  workRoot: string;
  /** `owner/name` of the repository the attempts write in. */
  repo: string;
  /**
   * The repository the worktrees are added to: the user's clone (`source: local`) or the
   * managed clone (`source: managed`, from `ensureManagedClone`).
   */
  clone: string;
  /** Default `origin`. */
  remote?: string;
  /** The clock for the age of a stale index.lock. */
  now?: () => number;
}

/** An attempt's worktree: where it is, its branch, and the commit it was at when made. */
export interface AttemptWorktree {
  path: string;
  branch: string;
  commit: string;
}

/** One line per item: what a cleanup removed, kept (with the reason) and could not remove. */
export interface CleanReport {
  done: string[];
  kept: string[];
  failed: string[];
}

export interface AttemptWorktrees {
  /** The folder the repository's attempt worktrees live in. */
  readonly root: string;
  /**
   * Fetches, then gives a new attempt its worktree on its own branch at `base` (a commit or a
   * ref such as `origin/main`). Call it only for an attempt whose lease the caller holds and
   * that has not started. Throws when something of the attempt is in the way.
   */
  create(ref: AttemptRef, base: string): Promise<AttemptWorktree>;
  /**
   * Gives a resumed attempt its worktree back (ADR 0019): the one that is there, or a new one on
   * its branch, or at `commit` when the branch is gone. Throws when that cannot be done.
   */
  recreate(ref: AttemptRef, commit: string): Promise<AttemptWorktree>;
  /**
   * Removes the worktrees, folders and local branches that nothing claims, and stale index.lock
   * files of kept worktrees no attempt runs in. At engine start without `batchId` (crash
   * repair); with it, when that batch has ended.
   */
  clean(claims: Claims, scope?: { batchId?: string }): Promise<CleanReport>;
}

/**
 * A fetch of a large repository takes a while, and so does a checkout from a partial clone,
 * which downloads every file then; a stalled one must still end.
 */
const FETCH_TIMEOUT_MS = 300_000;
/** The first clone of a large repository takes longer still. */
const CLONE_TIMEOUT_MS = 1_800_000;

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');

const why = ({ code, stderr }: GitResult): string =>
  lines(stderr)[0]?.trim() ??
  (code === null ? 'git did not finish in time' : `git exited with ${code}`);

// The output of a git call that must succeed.
const must = async (
  git: Git,
  cwd: string,
  args: string[],
  options?: GitOptions,
): Promise<string> => {
  const result = await git(cwd, args, options);
  // `worktree list` or `worktree add`, not just `worktree`.
  const command = args.slice(0, args[0] === 'worktree' ? 2 : 1).join(' ');
  if (result.code !== 0) throw new Error(`git ${command} failed: ${why(result)}`);
  return result.stdout;
};

const entriesOf = (path: string) =>
  readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  });

// The folders below the attempts root: `<stepId>/<attempt>` per batch, and whatever is not a
// step folder as it is.
const readBatchFolders = async (root: string): Promise<BatchFolderFact[]> => {
  const folders: BatchFolderFact[] = [];
  for (const batch of await entriesOf(root)) {
    if (!batch.isDirectory()) continue;
    const attempts: string[] = [];
    for (const step of await entriesOf(join(root, batch.name))) {
      if (!step.isDirectory()) attempts.push(step.name);
      else {
        for (const attempt of await entriesOf(join(root, batch.name, step.name))) {
          attempts.push(`${step.name}/${attempt.name}`);
        }
      }
    }
    const withGit = attempts.filter((entry) =>
      existsSync(join(root, batch.name, ...entry.split('/'), '.git')),
    );
    folders.push({ batchId: batch.name, attempts, withGit });
  }
  return folders;
};

// Removes a folder and the empty folders below it; false, removing nothing more, when anything
// else is in it.
const removeEmptyFolders = async (path: string): Promise<boolean> => {
  for (const entry of await entriesOf(path)) {
    if (!entry.isDirectory() || !(await removeEmptyFolders(join(path, entry.name)))) return false;
  }
  // Retried like any removal while Windows still holds the folder; gone already is fine.
  await removeTree(path, { removePath: rmdir }).catch((error: unknown) => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
  return true;
};

export const openAttemptWorktrees = (options: AttemptWorktreesOptions): AttemptWorktrees => {
  const { git, workRoot, repo, clone, remote = 'origin', now = Date.now } = options;
  const root = join(workRoot, repoFolder(repo), 'attempts');
  const okGit = gitThrough(git);
  // git lists worktrees by their real path, so the attempts root is compared through links
  // (a work root on a linked folder, macOS /var for /private/var).
  const realRoot = async (): Promise<string> => {
    await mkdir(workRoot, { recursive: true });
    return join(await realpath(workRoot), repoFolder(repo), 'attempts');
  };
  const listWorktrees = async () =>
    parseWorktreeList(await must(git, clone, ['worktree', 'list', '--porcelain', '-z']));
  const readRecordsOfClone = async () => {
    const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    return readRecords((await must(git, clone, args)).trim());
  };
  const recordOf = (records: { dir: string; folder: string | undefined }[], path: string) =>
    records.find(({ folder }) => folder !== undefined && samePath(folder, path))?.dir;
  // Whether the folder's .git file names its record. A brewer can rewrite that file, and git
  // run there would read the repository it names, core.fsmonitor and all.
  const pointsAt = async (path: string, record: string): Promise<boolean> => {
    const dotGit = join(path, '.git');
    if (!(await lstat(dotGit)).isFile()) return false;
    const gitdir = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim();
    return gitdir !== undefined && samePath(resolve(path, gitdir), record);
  };
  // The state of a worktree folder, with git run against its record only, never by
  // discovery from inside the folder. With `outDoc`, that untracked file alone still counts as
  // clean, and is named (ADR 0081).
  const stateOf = async (
    path: string,
    record: string | undefined,
    outDoc?: string,
  ): Promise<{ state: FolderState; outDoc?: string }> => {
    if (!existsSync(path)) return { state: 'gone' };
    if (!existsSync(join(path, '.git'))) return { state: 'no-git' };
    if (record === undefined || !(await pointsAt(path, record))) return { state: 'foreign' };
    const args = [`--git-dir=${record}`, `--work-tree=${path}`, 'status', '--porcelain'];
    const status = await git(clone, args, { config: { 'core.fsmonitor': 'false' } });
    return status.code === 0 ? worktreeStatus(status.stdout, outDoc) : { state: 'dirty' };
  };
  // One fetch at a time: concurrent fetches in one clone fail on git's ref locks.
  let fetching: Promise<unknown> = Promise.resolve();
  const fetchOnce = (): Promise<string> => {
    const fetched = fetching.then(() =>
      must(git, clone, ['fetch', '--quiet', remote], { timeoutMs: FETCH_TIMEOUT_MS }),
    );
    fetching = fetched.catch(() => undefined);
    return fetched;
  };
  const commitOf = async (revision: string): Promise<string | undefined> => {
    const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`];
    const resolved = await git(clone, args);
    return resolved.code === 0 ? resolved.stdout.trim() : undefined;
  };

  const attach = async (ref: AttemptRef, target: Target): Promise<AttemptWorktree> => {
    const branch = attemptBranch(ref);
    const inside = attemptFolder(ref);
    const path = join(await realRoot(), ...inside.split('/'));
    const worktrees = await listWorktrees();
    const tip = await git(clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    const branchTip = tip.code === 0 ? tip.stdout.trim() : undefined;
    const here = worktrees.find((worktree) => samePath(worktree.path, path));
    let listed: ListedFact | undefined;
    if (here !== undefined) {
      const record = recordOf(await readRecordsOfClone(), here.path);
      listed = { ...here, inside, state: (await stateOf(here.path, record)).state, record };
    }
    const checkedOutAt = worktrees.find(
      (worktree) => worktree.branch === branch && !samePath(worktree.path, path),
    )?.path;
    const facts = { listed, folderExists: existsSync(path), branchTip, checkedOutAt };
    const plan = planWorktree(ref, facts, target);
    switch (plan.kind) {
      case 'reuse':
        return { path, branch, commit: branchTip ?? '' };
      case 'refuse':
        throw new Error(`Attempt ${inside} cannot get its worktree: ${plan.reason}`);
      case 'add': {
        if (plan.prune !== undefined) {
          await removeWorktree(okGit, clone, { kind: 'prune', record: plan.prune });
        }
        const args = plan.newBranch ? ['-b', branch, '--', path, plan.at] : ['--', path, branch];
        await must(git, clone, ['worktree', 'add', ...args], { timeoutMs: FETCH_TIMEOUT_MS });
        return { path, branch, commit: plan.newBranch ? plan.at : (branchTip ?? '') };
      }
      default: {
        const unknown: never = plan;
        throw new Error(`Unknown plan ${JSON.stringify(unknown)}`);
      }
    }
  };

  // Carries out one action; the line it reports, if any.
  const carryOut = async (action: Action): Promise<string | undefined> => {
    switch (action.kind) {
      case 'remove':
        await removeWorktree(okGit, clone, action);
        return `removed worktree ${action.label}`;
      case 'finish':
        await removeWorktree(okGit, clone, action);
        return `finished removing worktree ${action.label}: its .git file was gone`;
      case 'prune':
        await removeWorktree(okGit, clone, action);
        return `pruned stale worktree ${action.label}: folder is gone`;
      case 'remove-folder':
        await removeTree(action.path);
        return `removed folder ${action.label}: git does not know it as a worktree`;
      case 'remove-batch-folder':
        return (await removeEmptyFolders(action.path))
          ? `removed batch folder ${action.label}`
          : undefined;
      case 'delete-branch':
        // Only while it still points where the facts saw it; its config section goes too.
        await must(git, clone, ['update-ref', '-d', `refs/heads/${action.branch}`, action.tip]);
        await git(clone, ['config', '--remove-section', `branch.${action.branch}`]);
        return `deleted branch ${action.branch}`;
      case 'index-lock':
        return (await removeStaleIndexLock(action.gitDir, { now })) === 'removed'
          ? `removed a stale index.lock of worktree ${action.label}`
          : undefined;
      default: {
        const unknown: never = action;
        throw new Error(`Unknown action ${JSON.stringify(unknown)}`);
      }
    }
  };

  return {
    root,
    async create(ref, base) {
      attemptBranch(ref);
      await fetchOnce();
      const resolved = await commitOf(base);
      if (resolved === undefined) throw new Error(`The base ${base} is no commit in ${clone}`);
      return attach(ref, { kind: 'new', base: resolved });
    },
    async recreate(ref, commit) {
      attemptBranch(ref);
      // A recorded commit comes from the state branch: never let it pass as an option.
      const resolved = await commitOf(commit);
      if (resolved === undefined) throw new Error(`The commit ${commit} is no commit in ${clone}`);
      return attach(ref, { kind: 'resume', commit: resolved });
    },
    async clean(claims, scope = {}) {
      const root = await realRoot();
      const records = await readRecordsOfClone();
      const worktrees: ListedFact[] = [];
      for (const worktree of await listWorktrees()) {
        const inside = pathInside(root, worktree.path);
        const record = recordOf(records, worktree.path);
        // The out doc of the attempt's step, which every attempt that ran here wrote (ADR 0081).
        const ref = inside === undefined ? undefined : parseAttemptFolder(inside);
        const outDoc = ref && claims.outDocs?.get(`${ref.batchId}/${ref.stepId}`);
        const status =
          inside === undefined
            ? { state: 'unchecked' as const }
            : await stateOf(worktree.path, record, outDoc);
        worktrees.push({ ...worktree, inside, ...status, record });
      }
      const format = '--format=%(refname:lstrip=2)%00%(objectname)';
      const refs = await must(git, clone, ['for-each-ref', format, 'refs/heads/foedrum/']);
      const branches = lines(refs).map((line) => {
        const [name = '', tip = ''] = line.split('\0');
        return { name, tip };
      });
      const folders = await readBatchFolders(root);
      const plan = planClean({ worktrees, branches, folders }, claims, root, scope);

      const report: CleanReport = { done: [], kept: plan.kept, failed: [] };
      for (const action of plan.actions) {
        // A worktree's branch is deleted only once the worktree is gone.
        const steps: Action[] = [action];
        if ('branch' in action && action.kind !== 'delete-branch' && action.branch !== undefined) {
          const { name, tip } = action.branch;
          steps.push({ kind: 'delete-branch', branch: name, tip });
        }
        for (const step of steps) {
          try {
            const line = await carryOut(step);
            if (line !== undefined) report.done.push(line);
          } catch (error) {
            const item = step.kind === 'delete-branch' ? `branch ${step.branch}` : step.label;
            report.failed.push(`could not clean ${item}: ${(error as Error).message}`);
            break;
          }
        }
      }
      return report;
    },
  };
};

export interface ManagedCloneOptions {
  git: Git;
  workRoot: string;
  repo: string;
  /** Where to clone from. */
  url: string;
  /** A local clone to borrow objects from (`--reference`). */
  reference?: string;
  /** The rename that moves the finished clone into place; default the file system's. */
  rename?: Rename;
}

// A URL as it may be shown: without a user name or password, which may be a token.
const withoutCredentials = (url: string): string => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.username === '' && parsed.password === '')) return url;
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
};

/** Where the managed clone of `repo` is in the work root (ADR 0012). */
export const managedClonePath = (workRoot: string, repo: string): string =>
  join(workRoot, repoFolder(repo), 'clone.git');

/**
 * The repository's managed clone (`source: managed`, ADR 0012): a bare partial clone in the work
 * root, made once. Returns its path.
 */
export const ensureManagedClone = async (options: ManagedCloneOptions): Promise<string> => {
  const { git, workRoot, repo, url, reference } = options;
  const path = managedClonePath(workRoot, repo);
  const folder = dirname(path);
  if (existsSync(path)) return path;
  // Cloned next to its place and renamed when done, so a crash never leaves half a clone there.
  const partial = join(folder, 'clone.partial');
  await removeTree(partial);
  await mkdir(folder, { recursive: true });
  // Credentials in the URL would be in the process list and in the clone's config; a
  // credential helper provides them instead.
  if (withoutCredentials(url) !== url) {
    throw new Error(
      `The clone URL ${withoutCredentials(url)} must not carry credentials; use a credential helper`,
    );
  }
  const borrow = reference === undefined ? [] : ['--reference', reference];
  const args = ['clone', '--bare', '--filter=blob:none', ...borrow, '--', url, partial];
  const cloned = await git(folder, args, { timeoutMs: CLONE_TIMEOUT_MS });
  if (cloned.code !== 0) {
    await removeTree(partial);
    throw new Error(`git clone of ${withoutCredentials(url)} failed: ${why(cloned)}`);
  }
  // A bare clone fetches into nothing by default; into origin/* like any clone, so a fetch
  // never moves Foedrum's own branches.
  await must(git, partial, [
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
  // Retried while Windows still holds a file the clone just wrote.
  await replaceFile(partial, path, options.rename === undefined ? {} : { rename: options.rename });
  return path;
};
