// The pushes of the openPullRequest action (ADR 0071), the shell: git in the repository's clone,
// never in an attempt's worktree (ADR 0066). Git runs only through the injected `Git`, so unit
// tests pass a fake one (ADR 0021).

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
import type { Git, GitOptions, GitResult } from './git.ts';

export interface BranchPushOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
  /** Default `origin`. */
  remote?: string;
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
const PATCHES = [
  'log',
  ...SHOWN,
  '--format=%x00%H',
  '--patch',
  '--diff-merges=first-parent',
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
/** Past the runner's output limit (ADR 0035), the scan reads no further and refuses. */
const TOO_LARGE = 'more than 4 MiB of messages or changes, past what the scan reads';

/** A push of a large repository takes a while; the effect's deadline aborts it sooner. */
const PUSH_TIMEOUT_MS = 300_000;

const SHA = /^[0-9a-f]{40}$/;
// A branch Foedrum pushes, so that nothing from outside reaches git as an option or a refspec.
const FOEDRUM_BRANCH = /^foedrum\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/;

const firstLine = ({ code, stderr }: GitResult): string =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ??
  (code === null ? 'git did not finish in time' : `git exited with ${code}`);

// The signal as git's options take it.
const aborts = (signal: AbortSignal | undefined): GitOptions =>
  signal === undefined ? {} : { signal };

const foedrumBranch = (branch: string): string => {
  if (!FOEDRUM_BRANCH.test(branch)) {
    throw new Error(`${JSON.stringify(branch)} is no branch in foedrum/`);
  }
  return branch;
};

export const openBranchPush = (options: BranchPushOptions): BranchPush => {
  const { git, clone, remote = 'origin' } = options;
  const must = async (args: string[], gitOptions: GitOptions): Promise<string> => {
    const result = await git(clone, args, gitOptions);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${firstLine(result)}`);
    return result.stdout;
  };
  return {
    commit: async (revision, signal) => {
      const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`];
      const result = await git(clone, args, aborts(signal));
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
      const result = await git(clone, args, aborts(signal));
      // 0: an ancestor, 1: not one; anything else is git failing.
      if (result.code === 0 || result.code === 1) return result.code === 0;
      throw new Error(`git merge-base failed: ${firstLine(result)}`);
    },
    remoteTip: async (branch, signal) => {
      const ref = `refs/heads/${foedrumBranch(branch)}`;
      const listed = await must(['ls-remote', '--refs', remote, ref], aborts(signal));
      for (const line of listed.split(/\r?\n/)) {
        const [commit, name] = line.split('\t');
        if (name === ref && commit !== undefined && SHA.test(commit)) return commit;
      }
      return undefined;
    },
    push: async (commit, branch, signal) => {
      if (!SHA.test(commit)) throw new Error(`${commit} is no full commit sha`);
      const refspec = `${commit}:refs/heads/${foedrumBranch(branch)}`;
      // Never by force, and no hook of the clone runs: not the user's, and not one a brewer's code
      // wrote into the clone its worktree shares (`--no-verify` alone skips only pre-push).
      await must(['push', '--no-verify', remote, refspec], {
        ...aborts(signal),
        timeoutMs: PUSH_TIMEOUT_MS,
        config: { 'core.hooksPath': devNull },
      });
    },
    secretScan: async (base, commit, signal) => {
      for (const sha of [base, commit]) {
        if (!SHA.test(sha)) throw new Error(`${sha} is no full commit sha`);
      }
      const range = ['--end-of-options', commit, `^${base}`];
      const options: GitOptions = { ...aborts(signal), ...AS_COMMITTED };
      const read = async (args: string[]): Promise<string | undefined> => {
        const result = await git(clone, args, options);
        if (result.killed === 'too-much-output') return undefined;
        if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${firstLine(result)}`);
        return result.stdout;
      };
      const messages = await read([...MESSAGES, ...range]);
      const headers = messages === undefined ? undefined : await read([...HEADERS, ...range]);
      const patches = headers === undefined ? undefined : await read([...PATCHES, ...range]);
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
        const checked = await must(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
          ...options,
          stdin: candidates.map((sha) => `${sha}\n`).join(''),
        });
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
  };
};
