// The state branch's shell (ADR 0011, ADR 0024): gathers facts from git and the store, and
// carries out what state-branch.ts decides. Git runs only through the injected `Git`.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Git, GitOptions } from '../workspace/git.ts';
import type { EventStore } from './event-store.ts';
import {
  classifyPush,
  commitMessage,
  decideStart,
  isLogPath,
  logPathOf,
  mergeLogs,
  outDocPath,
  planCatchUp,
  planFlush,
  type StartDecision,
  StateBranchStopError,
} from './state-branch.ts';

export interface StateBranchOptions {
  store: EventStore;
  git: Git;
  /** The Brewery clone. */
  clone: string;
  /** The state branch's own worktree, in the work root outside the clone (ADR 0012). */
  worktree: string;
  /** Default `origin`. */
  remote?: string;
  /** Default `foedrum/state`. */
  branch?: string;
}

export type FlushResult =
  | { kind: 'pushed'; through: number; commit: string }
  /** Nothing to push. */
  | { kind: 'unchanged' }
  /** Not pushed (no network, a remote hook); the marker stays and the next boundary retries. */
  | { kind: 'failed'; reason: string };

export interface StartResult {
  decision: StartDecision['kind'];
  flush?: FlushResult;
}

export interface StateBranch {
  /**
   * Opens the state worktree, checks that a commit can be made (and signed, when the clone
   * signs), and brings the store and the branch in line. Throws `StateBranchStopError` when the
   * engine must not run.
   */
  start(): Promise<StartResult>;
  /**
   * Writes the out doc of an attempt into the state worktree. Call it before appending the event
   * that refers to it, so both go into the same commit.
   */
  writeOutDoc(
    attempt: { batchId: string; stepId: string; attempt: number },
    text: string,
  ): Promise<void>;
  /**
   * Commits and pushes every event after the pushed-through marker; call it at every step
   * boundary. Throws `StateBranchStopError` when the push is rejected: another engine wrote.
   */
  flush(): Promise<FlushResult>;
}

/** The ref of the signing check's test commit; deleted again right away. */
const PROBE_REF = 'refs/foedrum/signing-check';
/** A signing prompt that nobody answers must not hold up the start for long. */
const PROBE_TIMEOUT_MS = 10_000;
const PUSH_TIMEOUT_MS = 120_000;
/** Files are written next to their place and renamed, so a crash never leaves half a log. */
const TMP_SUFFIX = '.foedrum-tmp';

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .find((line) => line.trim() !== '')
    ?.trim() ?? '';

const why = ({ code, stderr }: { code: number | null; stderr: string }): string =>
  firstLine(stderr) || (code === null ? 'git did not finish in time' : `git exited with ${code}`);

export const openStateBranch = (options: StateBranchOptions): StateBranch => {
  const { store, git, clone, worktree, remote = 'origin', branch = 'foedrum/state' } = options;
  const ref = `refs/heads/${branch}`;
  const remoteBranch = `${remote}/${branch}`;

  const must = async (cwd: string, args: string[], gitOptions?: GitOptions): Promise<string> => {
    const result = await git(cwd, args, gitOptions);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${why(result)}`);
    return result.stdout;
  };
  const onDisk = (path: string): string => join(worktree, ...path.split('/'));
  const write = async (path: string, text: string): Promise<void> => {
    const file = onDisk(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}${TMP_SUFFIX}`, text);
    await rename(`${file}${TMP_SUFFIX}`, file);
  };
  const read = (path: string): Promise<string | undefined> =>
    readFile(onDisk(path), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  /** The log files in the worktree. */
  const logFiles = async (): Promise<string[]> => {
    const names = await readdir(onDisk('batches')).catch(() => []);
    return ['events.jsonl', ...names.map((name) => `batches/${name}/events.jsonl`)].filter(
      (path) => isLogPath(path) && existsSync(onDisk(path)),
    );
  };
  const head = async (): Promise<string | undefined> => {
    const result = await git(worktree, ['rev-parse', '--verify', '-q', 'HEAD']);
    return result.code === 0 ? result.stdout.trim() : undefined;
  };
  /** The remote branch's commit, or undefined when it does not exist. */
  const remoteHead = async (cwd: string): Promise<string | undefined> => {
    const result = await git(cwd, ['ls-remote', '--exit-code', remote, ref]);
    if (result.code === 2) return undefined;
    const sha = result.stdout.split(/\s/)[0];
    if (result.code !== 0 || !sha) throw new Error(`Cannot read ${remoteBranch}: ${why(result)}`);
    return sha;
  };

  const openWorktree = async (remoteSha: string | undefined): Promise<void> => {
    if (existsSync(join(worktree, '.git'))) {
      const current = (await must(worktree, ['symbolic-ref', '--short', 'HEAD'])).trim();
      if (current !== branch) {
        throw new Error(`The state worktree ${worktree} is on ${current}, not on ${branch}`);
      }
      return;
    }
    const local = await git(clone, ['rev-parse', '--verify', '-q', ref]);
    const add =
      local.code === 0
        ? [worktree, branch]
        : remoteSha !== undefined
          ? ['--no-track', '-b', branch, worktree, remoteSha]
          : ['--orphan', '-b', branch, worktree];
    await must(clone, ['worktree', 'add', ...add]);
  };

  // One test commit, signed when the clone signs, so a broken signing setup refuses the start
  // instead of failing every step boundary (ADR 0024).
  const checkSigning = async (): Promise<void> => {
    const config = await git(worktree, ['config', '--type=bool', '--get', 'commit.gpgsign']);
    const signing = config.code === 0 && config.stdout.trim() === 'true';
    const tree = (await must(worktree, ['write-tree'])).trim();
    const commit = await git(worktree, ['commit-tree', tree, '-m', 'Foedrum signing check'], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (commit.code !== 0) {
      throw new StateBranchStopError(
        signing
          ? `Commit signing is on (commit.gpgSign) in ${clone}, but a test commit could not be signed without a prompt: ${why(commit)}. Make signing work non-interactively, or turn commit.gpgSign off for this clone.`
          : `A test commit in the state worktree ${worktree} failed: ${why(commit)}`,
      );
    }
    const sha = commit.stdout.trim();
    await must(worktree, ['update-ref', PROBE_REF, sha]);
    await must(worktree, ['update-ref', '-d', PROBE_REF, sha]);
  };

  const restore = async (localHead: string | undefined, remoteSha: string): Promise<void> => {
    const status = await must(worktree, ['status', '--porcelain', '-z', '--untracked-files=all']);
    // Untracked out docs may stay; anything else would be lost or mixed into the logs.
    const changed = status
      .split('\0')
      .filter((entry) => entry !== '' && (!entry.startsWith('?? ') || isLogPath(entry.slice(3))));
    if (changed.length > 0) {
      throw new StateBranchStopError(
        `The state worktree ${worktree} has changes that a rebuild would lose: ${changed.join(', ')}`,
      );
    }
    if (localHead !== remoteSha) {
      const merged = await git(worktree, ['merge', '--ff-only', '-q', remoteSha]);
      if (merged.code !== 0) {
        throw new StateBranchStopError(
          `The state worktree at ${localHead ?? 'no commit'} cannot fast-forward to ${remoteBranch} at ${remoteSha}: ${why(merged)}`,
        );
      }
    }
    const files = await Promise.all(
      (await logFiles()).map(async (path) => ({ path, text: (await read(path)) ?? '' })),
    );
    store.restore(planCatchUp(mergeLogs(files), store.eventsAfter(0)), remoteSha);
  };

  /** `checkAll` also checks log files no pending event goes to (ADR 0024: a recovery flush). */
  const flushNow = async (checkAll: boolean): Promise<FlushResult> => {
    const from = store.pushedThrough()?.eventId ?? 0;
    const pending = store.eventsAfter(from);
    const last = pending.at(-1);
    if (last === undefined) return { kind: 'unchanged' };
    const paths = new Set(pending.map((stored) => logPathOf(stored.event)));
    if (checkAll) for (const path of await logFiles()) paths.add(path);
    const current = new Map(
      await Promise.all([...paths].map(async (path) => [path, await read(path)] as const)),
    );
    for (const file of planFlush(current, pending, from)) await write(file.path, file.text);
    // The branch holds the same bytes on every machine, whatever core.autocrlf says.
    if (!existsSync(onDisk('.gitattributes'))) await write('.gitattributes', '* -text\n');

    await must(worktree, ['add', '-A', '--', '.', `:(exclude,glob)**/*${TMP_SUFFIX}`]);
    const staged = await git(worktree, ['diff', '--cached', '--quiet']);
    if (staged.code === 1) {
      const committed = await git(worktree, [
        'commit',
        '--no-verify',
        '-q',
        '-m',
        commitMessage(pending),
      ]);
      if (committed.code !== 0) return { kind: 'failed', reason: why(committed) };
    } else if (staged.code !== 0) {
      throw new Error(`git diff failed: ${why(staged)}`);
    }
    const commit = await head();
    if (commit === undefined) throw new Error(`The state worktree ${worktree} has no commit`);

    const pushed = await git(
      worktree,
      ['push', '--porcelain', '--no-verify', remote, `${ref}:${ref}`],
      { timeoutMs: PUSH_TIMEOUT_MS },
    );
    const outcome = classifyPush(pushed);
    switch (outcome) {
      case 'pushed':
        store.withTransaction((tx) => tx.markPushed({ eventId: last.id, commit }));
        return { kind: 'pushed', through: last.id, commit };
      case 'rejected': {
        const moved = await remoteHead(worktree).catch(() => undefined);
        throw new StateBranchStopError(
          `Another engine pushed to the state branch: ${remoteBranch} is at ${moved ?? 'an unknown commit'}, ` +
            `and this engine's head ${commit} with events ${from + 1}–${last.id} cannot be pushed. ` +
            'The engine stops; Foedrum never merges or rewrites state history.',
        );
      }
      case 'failed':
        return { kind: 'failed', reason: why(pushed) };
      default: {
        const unknown: never = outcome;
        throw new Error(`Unknown push outcome ${String(unknown)}`);
      }
    }
  };

  // One flush at a time: a second one waits and then pushes what is left.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = (checkAll: boolean): Promise<FlushResult> => {
    const run = queue.then(() => flushNow(checkAll));
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    start: async () => {
      const remoteSha = await remoteHead(clone);
      if (remoteSha !== undefined) {
        await must(clone, ['fetch', '--no-tags', remote, `+${ref}:refs/remotes/${remoteBranch}`]);
      }
      await openWorktree(remoteSha);
      await checkSigning();
      const pushed = store.pushedThrough();
      const localHead = await head();
      const pushedReachesRemote =
        pushed !== undefined &&
        remoteSha !== undefined &&
        (pushed.commit === remoteSha ||
          (await git(worktree, ['merge-base', '--is-ancestor', pushed.commit, remoteSha])).code ===
            0);
      const decision = decideStart({
        branch: remoteBranch,
        lastEventId: store.lastEventId(),
        pushed,
        localHead,
        remoteHead: remoteSha,
        pushedReachesRemote,
      });
      switch (decision.kind) {
        case 'ready':
          return { decision: 'ready' };
        case 'flush':
          return {
            decision: 'flush',
            flush: await serialized(localHead !== pushed?.commit),
          };
        case 'restore':
          await restore(localHead, remoteSha as string);
          return { decision: 'restore' };
        case 'stop':
          throw new StateBranchStopError(decision.reason);
        default: {
          const unknown: never = decision;
          throw new Error(`Unknown start decision ${JSON.stringify(unknown)}`);
        }
      }
    },

    writeOutDoc: async (attempt, text) => write(outDocPath(attempt), text),

    flush: () => serialized(false),
  };
};
