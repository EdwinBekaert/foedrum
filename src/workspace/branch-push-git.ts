// The pushes of the openPullRequest action (ADR 0071), the shell: git in the repository's clone,
// never in an attempt's worktree (ADR 0066), with no hook or fsmonitor (ADR 0137); the base is
// fetched from a git directory of its own (ADR 0090). Git runs only through the injected `Git`, so
// unit tests pass a fake one (ADR 0021).

import { devNull } from 'node:os';
import type { BranchPush } from '../engine/pull-request-actions.ts';
import {
  commitCandidates,
  messageCommits,
  rawCommits,
  scanHeaders,
  scanMessages,
  scanPatches,
} from '../formats/commit-scan.ts';
import {
  firstLine,
  gitOutput,
  inClone,
  type OwnGitDir,
  type OwnRemote,
  withOwnGitDir,
} from './clone-git.ts';
import type { Git, GitOptions } from './git.ts';

export interface BranchPushOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
  /**
   * The clone's remote, which the push and its lookup reach, and whose `<remote>/<base>` the base
   * fetch starts from; default `origin`.
   */
  remote?: string;
  /**
   * The remote as Foedrum names it, which the base fetch reaches (ADR 0090); without it, it
   * refuses.
   */
  own?: OwnRemote;
}

/**
 * How the secret scan runs git (ADR 0079): on the objects as committed, so that no replace ref,
 * graft or shallow file in the clone, which every attempt worktree shares, hides a commit or
 * changes its parents, and with no attribute file of the user's. Its flags turn off what the
 * clone's configuration could otherwise change: diff drivers, textconv, prefixes, renames, notes,
 * signatures and colour.
 */
const AS_COMMITTED: GitOptions = {
  timeoutMs: 120_000,
  env: {
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: devNull,
    GIT_SHALLOW_FILE: devNull,
    // A partial clone would fetch a missing object, so a word asked of cat-file would leave.
    GIT_NO_LAZY_FETCH: '1',
  },
  config: {
    'core.attributesFile': devNull,
    'log.showRoot': 'true',
    // A graft file at /dev/null makes git print its deprecation hint ahead of every error.
    'advice.graftFileDeprecated': 'false',
    // No transport at all, whatever the git version: a lazy fetch fails here instead.
    'protocol.allow': 'never',
  },
};
const SHOWN = ['--no-notes', '--no-show-signature'];
const MESSAGES = ['log', ...SHOWN, '--encoding=UTF-8', '--format=%x00%H%n%B'];
// Every header as stored, which %B leaves out: the author, the committer, a signature, an encoding.
// Uncoloured, unabbreviated and not re-encoded, whatever the clone's color.ui, log.abbrevCommit or
// i18n.logOutputEncoding say.
const HEADERS = [
  'log',
  ...SHOWN,
  '--no-decorate',
  '--no-mailmap',
  '--no-color',
  '--no-abbrev-commit',
  '--encoding=none',
  '--format=raw',
];
/** When the headers read shows other commits than the messages read, something bent its output. */
const UNREAD_HEADERS = 'headers git did not show as stored';
// How a patch prints, whatever the clone's configuration says.
const DIFF = [
  '--unified=0',
  '--inter-hunk-context=0',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-renames',
  '--no-relative',
  '--ignore-submodules=none',
  '--submodule=short',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];
// Every commit but a merge, by its own change.
const PATCHES = ['log', ...SHOWN, '--format=%x00%H', '--patch', '--no-merges', ...DIFF];
// The merges, each with its parents: the engine's merge of the base (ADR 0164).
const MERGES = ['rev-list', '--merges', '--parents'];
/** Past the runner's output limit (ADR 0035), the scan reads no further and refuses. */
const TOO_LARGE = 'more than 4 MiB of messages or changes, past what the scan reads';

/** A push or fetch of a large repository takes a while; the effect's deadline aborts it sooner. */
const TRANSFER_TIMEOUT_MS = 300_000;

const SHA = /^[0-9a-f]{40}$/;
// A base branch as git reads it in a refspec: never an option, a second refspec or a range.
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
// A branch Foedrum pushes, so that nothing from outside reaches git as an option or a refspec.
const FOEDRUM_BRANCH = /^foedrum\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/;

/**
 * The patches of the commits in `range`, each commit after a NUL and its sha: every commit but a
 * merge by its own change, and each merge against its last parent, the base it brought in
 * (ADR 0164), so what the base added is never read as the batch's, and what the merge itself
 * adds is. The first parents' lines are read in their own commits. `undefined` past the output
 * limit.
 */
const mergedPatches = async (
  read: (args: string[]) => Promise<string | undefined>,
  range: readonly string[],
): Promise<string | undefined> => {
  const own = await read([...PATCHES, ...range]);
  const merges = own === undefined ? undefined : await read([...MERGES, ...range]);
  if (own === undefined || merges === undefined) return undefined;
  const parts = [own];
  for (const line of merges.split(/\r?\n/)) {
    const [merge, ...parents] = line.trim().split(' ');
    const last = parents.at(-1);
    if (merge === undefined || last === undefined || !SHA.test(merge) || !SHA.test(last)) continue;
    const patch = await read(['diff', '--patch', ...DIFF, '--end-of-options', last, merge]);
    if (patch === undefined) return undefined;
    parts.push(`\0${merge}\n${patch}`);
  }
  return parts.join('\n');
};

// The signal as git's options take it.
const aborts = (signal: AbortSignal | undefined): GitOptions =>
  signal === undefined ? {} : { signal };

// A git directory of the call's own, reaching the remote by the URL Foedrum names (ADR 0090).
const remotely = async <T>(
  { git, clone, own }: Pick<BranchPushOptions, 'git' | 'clone' | 'own'>,
  signal: AbortSignal | undefined,
  use: (dir: OwnGitDir) => Promise<T>,
): Promise<T> => {
  if (own === undefined) {
    throw new Error(`The pushes from ${clone} name no URL to reach the remote by`);
  }
  return withOwnGitDir(git, clone, own, signal, use);
};

const foedrumBranch = (branch: string): string => {
  if (!FOEDRUM_BRANCH.test(branch)) {
    throw new Error(`${JSON.stringify(branch)} is no branch in foedrum/`);
  }
  return branch;
};

export const openBranchPush = (options: BranchPushOptions): BranchPush => {
  const { git, clone, remote = 'origin' } = options;
  const local = inClone(git);
  return {
    commit: async (revision, signal) => {
      const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`];
      const result = await local(clone, args, aborts(signal));
      const commit = result.stdout.trim();
      if (result.code !== 0 || !SHA.test(commit)) {
        throw new Error(`The revision ${revision} is no commit in ${clone}`);
      }
      return commit;
    },
    isAncestor: async (commit, of, signal) => {
      for (const sha of [commit, of]) {
        if (!SHA.test(sha)) throw new Error(`${sha} is no full commit sha`);
      }
      const args = ['merge-base', '--is-ancestor', commit, of];
      const result = await local(clone, args, aborts(signal));
      // 0: an ancestor, 1: not one; anything else is git failing.
      if (result.code === 0 || result.code === 1) return result.code === 0;
      throw new Error(`git merge-base failed: ${firstLine(result)}`);
    },
    // The fetch runs in a git directory of its own (ADR 0090): no fetch at the same time, and
    // nothing a fetch killed at its deadline left (a ref's lock, a ref of a commit the clone has
    // pruned since), takes part.
    baseTip: async (name, signal) => {
      if (!BRANCH_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is no branch name`);
      return remotely(options, signal, async (dir) => {
        // The clone's own origin/<base>: where the fetch starts.
        const known = await local(
          clone,
          [
            'rev-parse',
            '--verify',
            '--quiet',
            '--end-of-options',
            `refs/remotes/${remote}/${name}^{commit}`,
          ],
          aborts(signal),
        );
        const have = known.stdout.trim();
        const ref = `refs/heads/${name}`;
        // The ref starts at the clone's base: the fetch then brings only what the clone lacks, and
        // git's check of what it brought stops there instead of walking a blobless clone's history
        // to blobs it never had.
        if (known.code === 0 && SHA.test(have)) await dir.run(['update-ref', ref, have]);
        await dir.fetch(`+${ref}:${ref}`, TRANSFER_TIMEOUT_MS);
        const fetched = (
          await dir.run(['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
        ).trim();
        if (!SHA.test(fetched)) throw new Error(`The fetch of ${name} named no commit: ${fetched}`);
        return fetched;
      });
    },
    remoteTip: async (branch, signal) => {
      const ref = `refs/heads/${foedrumBranch(branch)}`;
      const args = ['ls-remote', '--refs', remote, ref];
      const listed = await gitOutput(local, clone, args, aborts(signal));
      for (const line of listed.split(/\r?\n/)) {
        const [commit, name] = line.split('\t');
        if (name === ref && commit !== undefined && SHA.test(commit)) return commit;
      }
      return undefined;
    },
    push: async (commit, branch, signal) => {
      if (!SHA.test(commit)) throw new Error(`${commit} is no full commit sha`);
      const refspec = `${commit}:refs/heads/${foedrumBranch(branch)}`;
      // Never by force, and by the commit's sha: no ref of the clone names what is pushed. No hook
      // of the clone's runs: `--no-verify` alone would skip only pre-push. Only this one ref goes,
      // whatever push.followTags or push.recurseSubmodules say: nothing past the ledger.
      const args = ['push', '--no-verify', '--no-follow-tags', '--no-recurse-submodules'];
      await gitOutput(local, clone, [...args, remote, refspec], {
        ...aborts(signal),
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
    },
    secretScan: async (base, commit, signal) => {
      for (const sha of [base, commit]) {
        if (!SHA.test(sha)) throw new Error(`${sha} is no full commit sha`);
      }
      const range = ['--end-of-options', commit, `^${base}`];
      const options: GitOptions = { ...aborts(signal), ...AS_COMMITTED };
      const read = async (args: string[]): Promise<string | undefined> => {
        const result = await local(clone, args, options);
        if (result.killed === 'too-much-output') return undefined;
        if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${firstLine(result)}`);
        return result.stdout;
      };
      const messages = await read([...MESSAGES, ...range]);
      const headers = messages === undefined ? undefined : await read([...HEADERS, ...range]);
      const patches = headers === undefined ? undefined : await mergedPatches(read, range);
      if (messages === undefined || headers === undefined || patches === undefined) {
        return [{ commit, place: `the commits from ${base}`, kind: TOO_LARGE }];
      }
      if (rawCommits(headers).join(' ') !== messageCommits(messages).join(' ')) {
        return [{ commit, place: `the commits from ${base}`, kind: UNREAD_HEADERS }];
      }
      // A 40-character hexadecimal word is a key unless the clone has it as a commit; the commits'
      // own hashes, after each NUL, and the headers read's commit, tree and parent lines are not
      // read. A message's own `commit <sha>` line is asked as any other word.
      const hashes = headers.replace(/^(?:commit|tree|parent) [0-9a-f]+$/gm, '');
      const shown = `${messages}\n${hashes}\n${patches}`.replace(/\0[0-9a-f]{40}/g, '');
      const candidates = commitCandidates(shown);
      const commits = new Set<string>();
      if (candidates.length > 0) {
        const checked = await gitOutput(
          local,
          clone,
          ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
          {
            ...options,
            stdin: candidates.map((sha) => `${sha}\n`).join(''),
          },
        );
        for (const line of checked.split(/\r?\n/)) {
          const [sha, type] = line.split(' ');
          if (sha !== undefined && type === 'commit') commits.add(sha.toLowerCase());
        }
      }
      const isCommit = (sha: string): boolean => commits.has(sha.toLowerCase());
      return [
        ...scanMessages(messages, isCommit),
        ...scanHeaders(headers, isCommit),
        ...scanPatches(patches, isCommit),
      ];
    },
    touchedFiles: async (since, commit, signal) => {
      for (const sha of [since, commit]) {
        if (!SHA.test(sha)) throw new Error(`${sha} is no full commit sha`);
      }
      // Each path once, a rename's two as a deletion and an addition, never quoted after -z.
      const args = [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--no-relative',
        '--ignore-submodules=none',
        '--end-of-options',
        since,
        commit,
      ];
      const result = await local(clone, args, aborts(signal));
      if (result.code !== 0) throw new Error(`git diff failed: ${firstLine(result)}`);
      return result.stdout.split('\0').filter((path) => path !== '');
    },
  };
};
