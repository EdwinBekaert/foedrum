// The personal denylist's shell for the local gate (ADR 0114, ADR 0021): reads the list and the
// commits a push would send, through git with the process runner; scripts/denylist/core.ts
// decides.

import type { DenylistState } from '../src/platform/denylist.ts';
import { type ExecProcess, whyKilled } from '../src/platform/processes.ts';
import {
  deniedRefusal,
  type GhText,
  MESSAGE_FORMAT,
  parseDenylist,
  scanMessages,
  scanPatches,
} from './denylist/core.ts';

/** Each git call's deadline: a local, read-only call answers within seconds, and the three calls
 * fit between the HEAD check (10 s) and npm run check (540 s) under the hook's 600 s. */
export const DENYLIST_GIT_TIMEOUT_MS = 15_000;

// The commits the remote's tracking refs do not have: what a push of the branch to it can send.
// Another remote's refs (a private mirror) say nothing of what this one has. git reads them as
// stored (no replace refs) and prints paths as they are.
const GIT = ['--no-replace-objects', '-c', 'core.quotePath=false', '-c', 'log.showRoot=true'];
const commits = (remote: string): string[] => ['HEAD', '--not', `--remotes=${remote}`];
// A remote's name, which git reads as a pattern of its tracking refs: no glob, URL or path.
const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
// The current branch's push remote by name, as git works it out (branch.<name>.pushRemote,
// remote.pushDefault, branch.<name>.remote); a configured name may hold a slash.
const PUSH_REMOTE = [
  'for-each-ref',
  '--format=%(if)%(HEAD)%(then)%(push:remotename)%(end)',
  'refs/heads/',
];
const CONFIGURED_REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const PLAIN = ['--no-color', '--no-notes', '--no-show-signature', '--no-mailmap'];
const MESSAGES = [...GIT, 'log', `--format=${MESSAGE_FORMAT}`, '--encoding=UTF-8', ...PLAIN];
// Added lines only, merges as combined diffs (what the merge adds of its own), binary files as
// text, and no driver, textconv or rename between git and the bytes.
const PATCHES = [
  ...GIT,
  'log',
  '--format=%x00%H',
  '--patch',
  '--diff-merges=dense-combined',
  '--unified=0',
  '--inter-hunk-context=0',
  '--text',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--no-relative',
  '--ignore-submodules=none',
  '--submodule=short',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  ...PLAIN,
];

/**
 * Why a command's `git push` in `dir` to `remotes` may not run: the commits it would send hold a
 * word on the list, the list cannot be read, it pushes to more than one remote, the remote is
 * computed at run time or no name, or git cannot show the commits. Undefined without a list. A push that names no remote goes to the current branch's
 * push remote, or else to origin.
 */
export const pushRefusal =
  (readList: () => DenylistState, exec: ExecProcess) =>
  async (dir: string, ...remotes: (string | null | undefined)[]): Promise<string | undefined> => {
    const state = readList();
    if (state.kind === 'none') return undefined;
    if (state.kind === 'unreadable') {
      return `git push is blocked: the denylist at ${state.path} cannot be read (${state.why}), so the gate cannot check what the push sends (ADR 0114). Fix the file, or unset FOEDRUM_DENYLIST.`;
    }
    const list = parseDenylist(state.text);
    if (list.length === 0) return undefined;
    // One remote per command keeps the scan's git calls within one deadline budget.
    if (remotes.length > 1) {
      return 'git push is blocked: the command pushes to more than one remote, so the gate would scan what each one is sent against your denylist past its deadline (ADR 0114); push to each remote in a command of its own.';
    }
    const [remote] = remotes;
    if (remote === null || (remote !== undefined && !REMOTE_NAME.test(remote))) {
      return `git push is blocked: its remote is ${remote === null ? 'computed at run time' : 'a URL or a path'}, so the gate cannot tell which commits it sends to check them against your denylist (ADR 0114); name the remote, such as origin.`;
    }
    const options = { cwd: dir, timeoutMs: DENYLIST_GIT_TIMEOUT_MS };
    let target = remote;
    if (target === undefined) {
      const pushRemote = await exec('git', PUSH_REMOTE, options);
      const named = pushRemote.exitCode === 0 ? pushRemote.stdout.trim() : '';
      target = CONFIGURED_REMOTE.test(named) ? named : 'origin';
    }
    const outputs: string[] = [];
    for (const args of [MESSAGES, PATCHES]) {
      const { exitCode, stdout, killed } = await exec('git', [...args, ...commits(target)], {
        cwd: dir,
        timeoutMs: DENYLIST_GIT_TIMEOUT_MS,
      });
      const why =
        whyKilled(killed, DENYLIST_GIT_TIMEOUT_MS) ??
        (exitCode === null ? 'could not start' : exitCode === 0 ? undefined : `exited ${exitCode}`);
      if (why !== undefined) {
        return `git push is blocked: could not read the commits it would send to check them against your denylist (git log ${why}) (ADR 0114).`;
      }
      outputs.push(stdout);
    }
    const [messages = '', patches = ''] = outputs;
    const places = [...scanMessages(messages, list), ...scanPatches(patches, list)];
    return places.length === 0 ? undefined : deniedRefusal('git push', places);
  };

/**
 * Why the texts a command's gh calls would send may not go (ADR 0132): one holds a word on the
 * list, the list cannot be read, or the gate cannot read a text. Undefined without a list, before
 * anything is read. `readAt` reads a file at path parts resolved from `cwd`, and throws when it
 * cannot.
 */
export const textRefusal =
  (_readList: () => DenylistState, _readAt: (cwd: string, path: readonly string[]) => string) =>
  (_texts: readonly GhText[], _cwd: string): string | undefined => {
    throw new Error('not implemented');
  };
