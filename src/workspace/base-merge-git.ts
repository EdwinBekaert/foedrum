// The merge of the base before a batch's last check (ADR 0164), the shell: git in the check
// attempt's worktree, pointed at its record under the clone, never by discovery (ADR 0029), with
// no hook or fsmonitor (ADR 0137). Git runs only through the injected `Git`, so unit tests pass a
// fake one (ADR 0021).

import type { WorktreeMerge } from '../engine/base-merge.ts';
import { samePath } from '../platform/paths.ts';
import { isCommitSha, type KeptFile, MAX_CONFLICTS } from '../schemas/store.ts';
import { aborts, firstLine, fullSha, gitOutput, inClone } from './clone-git.ts';
import type { Git } from './git.ts';
import { readRecords } from './worktree-records.ts';

/** What `git status --porcelain=v2` calls each kind of unmerged file, by its XY. */
const UNMERGED: Readonly<Record<string, KeptFile['status']>> = {
  UU: 'both modified',
  AA: 'both added',
  DD: 'both deleted',
  AU: 'added by us',
  UA: 'added by them',
  DU: 'deleted by us',
  UD: 'deleted by them',
};

/** A merge of a large tree takes a while; the effect's deadline aborts it sooner. */
const MERGE_TIMEOUT_MS = 120_000;

export interface WorktreeMergeOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
}

export const openWorktreeMerge = ({ git, clone }: WorktreeMergeOptions): WorktreeMerge => {
  const engine = inClone(git);
  // The worktree's record under the clone: its folder's .git file, which a brewer can point at a
  // repository of its own, is never read (ADR 0029, ADR 0095).
  const recordOf = async (path: string, signal?: AbortSignal): Promise<string> => {
    const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    const common = (await gitOutput(engine, clone, args, aborts(signal))).trim();
    const records = await readRecords(common);
    const found = records.find(({ folder }) => folder !== undefined && samePath(folder, path));
    if (found === undefined) throw new Error(`${clone} has no record of the worktree ${path}`);
    return found.dir;
  };
  const local: Git = async (path, args, options = {}) => {
    const record = await recordOf(path, options.signal);
    return engine(path, [`--git-dir=${record}`, `--work-tree=${path}`, ...args], options);
  };
  const head = async (path: string, signal?: AbortSignal): Promise<string> => {
    const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'];
    const sha = (await gitOutput(local, path, args, aborts(signal))).trim();
    if (!isCommitSha(sha)) throw new Error(`The HEAD of ${path} names no commit: ${sha}`);
    return sha;
  };
  /** The commit a merge in progress merges: MERGE_HEAD is there while one is. */
  const mergeHead = async (path: string, signal?: AbortSignal): Promise<string | undefined> => {
    const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', 'MERGE_HEAD'];
    const found = await local(path, args, aborts(signal));
    return found.code === 0 ? fullSha(found.stdout.trim()) : undefined;
  };
  const abort = async (path: string, signal?: AbortSignal): Promise<void> => {
    if ((await mergeHead(path, signal)) !== undefined) {
      await gitOutput(local, path, ['merge', '--abort'], aborts(signal));
    }
  };
  /**
   * The files a merge in progress left unmerged, as `git status` names them (ADR 0244); of the
   * first `MAX_CONFLICTS`, the ones without a conflict marker, which git could not mark.
   */
  const unmergedFiles = async (path: string, signal?: AbortSignal): Promise<KeptFile[]> => {
    const args = ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules'];
    const fields = (await gitOutput(local, path, args, aborts(signal))).split('\0');
    const files: Omit<KeptFile, 'unmarked'>[] = [];
    for (let at = 0; at < fields.length; at++) {
      const entry = fields[at] ?? '';
      // A rename's or copy's entry is followed by its original path.
      if (entry.startsWith('2 ')) at++;
      if (!entry.startsWith('u ')) continue;
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = entry.split(' ');
      const status = UNMERGED[parts[1] ?? ''];
      if (status === undefined) throw new Error(`git status names an unknown conflict: ${entry}`);
      files.push({ path: parts.slice(10).join(' '), status });
    }
    const named = files.slice(0, MAX_CONFLICTS).map(({ path: file }) => file);
    if (named.length === 0) return files;
    // A file holds a marker when a line of it starts one; never a binary file (-I).
    const grep = ['--literal-pathspecs', 'grep', '-l', '-z', '-I', '-e', '^<<<<<<< ', '--'];
    const found = await local(path, [...grep, ...named], aborts(signal));
    if (found.code !== 0 && found.code !== 1)
      throw new Error(`git grep failed: ${firstLine(found)}`);
    const marked = new Set(found.stdout.split('\0'));
    return files.map((file, index) =>
      index < MAX_CONFLICTS && !marked.has(file.path) ? { ...file, unmarked: true } : file,
    );
  };
  return {
    head,
    parents: async (path, commit, signal) => {
      const args = ['rev-list', '--parents', '--max-count=1', '--end-of-options', fullSha(commit)];
      const [, ...parents] = (await gitOutput(local, path, args, aborts(signal))).trim().split(' ');
      return parents;
    },
    abort,
    pending: async (path, signal) => {
      const tip = await mergeHead(path, signal);
      return tip === undefined ? undefined : { tip, files: await unmergedFiles(path, signal) };
    },
    merge: async (path, commit, message, signal, keep = false) => {
      // A commit of its own, also when the start is behind the base, and no editor.
      const args = ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', message];
      const result = await local(path, [...args, '--end-of-options', fullSha(commit)], {
        ...aborts(signal),
        timeoutMs: MERGE_TIMEOUT_MS,
      });
      if (result.code === 0) return { kind: 'merged', commit: await head(path, signal) };
      // Left in progress, with its markers, for the brewer to conclude (ADR 0244).
      if (keep && (await mergeHead(path, signal)) !== undefined) {
        const files = await unmergedFiles(path, signal);
        if (files.length > 0) return { kind: 'kept', files };
      }
      const unmerged = await gitOutput(
        local,
        path,
        ['diff', '--no-ext-diff', '--name-only', '--diff-filter=U', '-z'],
        aborts(signal),
      );
      const files = unmerged.split('\0').filter((file) => file !== '');
      await abort(path, signal);
      if (files.length === 0) throw new Error(`git merge failed: ${firstLine(result)}`);
      return { kind: 'conflicts', files };
    },
  };
};
