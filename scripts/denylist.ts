// The personal denylist's shell for the local gate (ADR 0114, ADR 0021): reads the list and the
// commits a push would send, through git with the process runner; scripts/denylist/core.ts
// decides.

import type { DenylistState } from '../src/platform/denylist.ts';
import { type ExecProcess, whyKilled } from '../src/platform/processes.ts';
import {
  deniedRefusal,
  MESSAGE_FORMAT,
  parseDenylist,
  scanMessages,
  scanPatches,
} from './denylist/core.ts';

/** Each git call's deadline: a local, read-only log answers within seconds, and the two calls fit
 * between the HEAD check (10 s) and npm run check (540 s) under the hook's 600 s. */
export const DENYLIST_GIT_TIMEOUT_MS = 20_000;

// The commits no remote-tracking ref has: what a push of the branch can send. git reads them as
// stored (no replace refs) and prints paths as they are.
const GIT = ['--no-replace-objects', '-c', 'core.quotePath=false', '-c', 'log.showRoot=true'];
const COMMITS = ['HEAD', '--not', '--remotes'];
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
 * Why `git push` in `dir` may not run: the commits it would send hold a word on the list, the
 * list cannot be read, or git cannot show the commits. Undefined without a list.
 */
export const pushRefusal =
  (readList: () => DenylistState, exec: ExecProcess) =>
  async (dir: string): Promise<string | undefined> => {
    const state = readList();
    if (state.kind === 'none') return undefined;
    if (state.kind === 'unreadable') {
      return `git push is blocked: the denylist at ${state.path} cannot be read (${state.why}), so the gate cannot check what the push sends (ADR 0114). Fix the file, or unset FOEDRUM_DENYLIST.`;
    }
    const list = parseDenylist(state.text);
    if (list.length === 0) return undefined;
    const outputs: string[] = [];
    for (const args of [MESSAGES, PATCHES]) {
      const { exitCode, output, killed } = await exec('git', [...args, ...COMMITS], {
        cwd: dir,
        timeoutMs: DENYLIST_GIT_TIMEOUT_MS,
      });
      const why =
        whyKilled(killed, DENYLIST_GIT_TIMEOUT_MS) ??
        (exitCode === null ? 'could not start' : exitCode === 0 ? undefined : `exited ${exitCode}`);
      if (why !== undefined) {
        return `git push is blocked: could not read the commits it would send to check them against your denylist (git log ${why}) (ADR 0114).`;
      }
      outputs.push(output);
    }
    const [messages = '', patches = ''] = outputs;
    const places = [...scanMessages(messages, list), ...scanPatches(patches, list)];
    return places.length === 0 ? undefined : deniedRefusal('git push', places);
  };
