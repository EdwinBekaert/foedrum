// The personal denylist's shell for the local gate (ADR 0114, ADR 0021): reads the list and the
// commits a push would send, through git with the process runner; scripts/denylist/core.ts
// decides.

import type { DenylistState } from '../src/platform/denylist.ts';
import { type ExecProcess, type ExecResult, whyKilled } from '../src/platform/processes.ts';
import { windowsPathProblem } from '../src/platform/real-path.ts';
import {
  deniedRefusal,
  filePlaces,
  type GhText,
  holdsEntry,
  MESSAGE_FORMAT,
  parseDenylist,
  scanMessages,
  scanPatches,
  textPlaces,
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
// The current branch's name and, after a tab, its push remote by name, as git works it out
// (branch.<name>.pushRemote, remote.pushDefault, branch.<name>.remote); a configured name may hold
// a slash. A branch name holds no tab.
const CURRENT_BRANCH = [
  'for-each-ref',
  '--format=%(if)%(HEAD)%(then)%(refname:lstrip=2)%09%(push:remotename)%(end)',
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

// Why git failed, or undefined when it answered.
const failure = ({ exitCode, killed }: ExecResult): string | undefined =>
  whyKilled(killed, DENYLIST_GIT_TIMEOUT_MS) ??
  (exitCode === null ? 'could not start' : exitCode === 0 ? undefined : `exited ${exitCode}`);

/**
 * Why a command's `git push` in `dir` to `remotes` may not run: the commits it would send, the
 * current branch's name or a branch name its refspecs create (`destinations`, ADR 0246) hold a word
 * on the list, the list cannot be read, it pushes to more than one remote, the remote or a refspec
 * is computed at run time (null) or the remote is no name, or git cannot show the branch or the
 * commits. Undefined without a list. A push that names no remote goes to the current branch's
 * push remote, or else to origin.
 */
export const pushRefusal =
  (
    readList: () => DenylistState,
    exec: ExecProcess,
    destinations: readonly (string | null)[] = [],
  ) =>
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
    if (destinations.includes(null)) {
      return 'git push is blocked: a refspec is computed at run time, so the gate cannot tell which branch name it creates to check it against your denylist (ADR 0114, ADR 0246); give the branch name as it is.';
    }
    const options = { cwd: dir, timeoutMs: DENYLIST_GIT_TIMEOUT_MS };
    const current = await exec('git', CURRENT_BRANCH, options);
    const line = current.stdout.split(/\r?\n/).find((each) => each.includes('\t'));
    const unread = failure(current) ?? (line === undefined ? 'found no current branch' : undefined);
    if (unread !== undefined || line === undefined) {
      return `git push is blocked: could not read the branch it pushes to check its name against your denylist (git for-each-ref ${unread}) (ADR 0246).`;
    }
    const [branch = '', named = ''] = line.split('\t');
    const target = remote ?? (CONFIGURED_REMOTE.test(named) ? named : 'origin');
    const outputs: string[] = [];
    for (const args of [MESSAGES, PATCHES]) {
      const outcome = await exec('git', [...args, ...commits(target)], options);
      const why = failure(outcome);
      if (why !== undefined) {
        return `git push is blocked: could not read the commits it would send to check them against your denylist (git log ${why}) (ADR 0114).`;
      }
      outputs.push(outcome.stdout);
    }
    const [messages = '', patches = ''] = outputs;
    const names = [branch, ...destinations].filter((name) => name !== null);
    const places = [
      ...(names.some((name) => holdsEntry(name, list)) ? ['branch name'] : []),
      ...scanMessages(messages, list),
      ...scanPatches(patches, list),
    ];
    return places.length === 0 ? undefined : deniedRefusal('git push', places);
  };

/**
 * Why the texts a command's gh calls would send may not go (ADR 0132): one holds a word on the
 * list, the list cannot be read, or the gate cannot read a text. Undefined without a list, before
 * anything is read. `readAt` reads a file at path parts resolved from `cwd`, and throws when it
 * cannot.
 */
export const textRefusal =
  (readList: () => DenylistState, readAt: (cwd: string, path: readonly string[]) => string) =>
  (texts: readonly GhText[], cwd: string): string | undefined => {
    const [first] = texts;
    if (first === undefined) return undefined;
    const state = readList();
    if (state.kind === 'none') return undefined;
    if (state.kind === 'unreadable') {
      return `${first.command} is blocked: the denylist at ${state.path} cannot be read (${state.why}), so the gate cannot check what gh sends (ADR 0114, ADR 0132). Fix the file, or unset FOEDRUM_DENYLIST.`;
    }
    const list = parseDenylist(state.text);
    if (list.length === 0) return undefined;
    // Each reading of a command that runs another finds the same text again.
    const unique = [...new Map(texts.map((each) => [JSON.stringify(each), each])).values()];
    const hits: { command: string; place: string }[] = [];
    for (const each of unique) {
      const where = `${each.command} ${each.field}`;
      switch (each.kind) {
        case 'unreadable':
          return `${each.command} is blocked: its ${each.field} is ${each.why}, so the gate cannot check it against your denylist (ADR 0132); give the text inline, or in a file the gate can read.`;
        case 'text':
          hits.push(...textPlaces(where, each.text, list).map((place) => ({ ...each, place })));
          break;
        case 'file': {
          const shown = each.path.at(-1) ?? '';
          let text: string;
          try {
            text = readAt(cwd, each.path);
          } catch (error) {
            // The error names the path, which may hold the word.
            // The error names the path as resolved (the hook's directory, the home folder), so
            // it is quoted only when it holds no word either.
            const named = !holdsEntry(each.path.join('/'), list);
            const message = error instanceof Error ? error.message : String(error);
            const why = holdsEntry(message, list) ? 'its error names a denied word' : message;
            return `${each.command} is blocked: could not read its ${each.field} ${named ? `${shown} (${why})` : 'from a file whose path holds a denied word'}, so the gate cannot check it against your denylist (ADR 0132).`;
          }
          const places = filePlaces(where, shown, text, each.json === true, list);
          hits.push(...places.map((place) => ({ ...each, place })));
          break;
        }
        default: {
          const unknown: never = each;
          throw new Error(`unknown gh text ${JSON.stringify(unknown)}`);
        }
      }
    }
    const [hit] = hits;
    if (hit === undefined) return undefined;
    return deniedRefusal(hit.command, [...new Set(hits.map(({ place }) => place))]);
  };

/** The most a file gh would send may hold for the gate to read it: four times the 65,536
 * characters GitHub takes in a body, so a request body of JSON fits too. */
export const GH_FILE_MAX_BYTES = 262_144;

/** The file system a gh text's file is read through: its path resolved from where the hook
 * runs, what kind of file it is and how large, and its text. */
export interface GhFiles {
  resolve: (cwd: string, path: readonly string[]) => string;
  stat: (path: string) => { isFile: () => boolean; size: number };
  read: (path: string) => string;
}

/**
 * Reads the file a gh text names (ADR 0132), or throws why it will not: only a regular file of at
 * most GH_FILE_MAX_BYTES, so standard input as a path (/dev/stdin), a FIFO or a device never
 * blocks or empties the gate. The file as written is never a ~ path, which bash leaves as it is
 * after @ or in quotes and PowerShell always does, so gh may read a folder named ~; on Windows
 * never a network or device path, before anything touches it, nor a rooted or drive-relative one
 * (/tmp/…, /c/…, \…, D:…), which Git Bash, PowerShell or the drive's own folder send elsewhere.
 */
export const ghFileReader =
  (files: GhFiles, platform: NodeJS.Platform) =>
  (cwd: string, path: readonly string[]): string => {
    const file = path.at(-1) ?? '';
    if (file.startsWith('~')) throw new Error('a ~ path: give the path without ~');
    const resolved = files.resolve(cwd, path);
    if (platform === 'win32') {
      const problem = windowsPathProblem(file) ?? windowsPathProblem(resolved);
      if (problem === 'network') {
        throw new Error('a network or device path, which the gate does not open');
      }
      if (problem === 'no-drive') {
        throw new Error(
          'a rooted or drive-relative path, which gh may read from another folder: give a Windows or relative path',
        );
      }
    }
    const stat = files.stat(resolved);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > GH_FILE_MAX_BYTES) throw new Error(`over ${GH_FILE_MAX_BYTES} bytes`);
    return files.read(resolved);
  };
