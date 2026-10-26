// `foedrum serve`'s shell on the real machine (ADR 0063): the lock, the store, the state branch,
// each repository's attempt worktrees (a local clone, or a managed clone made from GitHub), the
// claude runner, and the signals that stop it. git comes in, so its use is tested with a fake.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeBrewerRunner } from '../brewers/claude-runner.ts';
import { lockDriver } from '../engine/driver-lock.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { openStateBranch } from '../engine/state-branch-git.ts';
import { type SandboxedChecksOptions, sandboxedChecks } from '../platform/check-sandbox.ts';
import { type AwakeMechanism, awakeCommand, keepAwake } from '../platform/keep-awake.ts';
import {
  type ExecProcess,
  execProcess,
  type ListenForSignal,
  stopOnSignals,
} from '../platform/processes.ts';
import { ownGitDirsRoot } from '../workspace/attempt-worktrees.ts';
import {
  ensureManagedClone,
  openAttemptWorktrees,
  worktreeClonePath,
} from '../workspace/attempt-worktrees-git.ts';
import { openWorktreeMerge } from '../workspace/base-merge-git.ts';
import { openBranchPush } from '../workspace/branch-push-git.ts';
import type { OwnRemote } from '../workspace/clone-git.ts';
import type { Git } from '../workspace/git.ts';
import { openMergedTree, openMergeTree } from '../workspace/merge-tree-git.ts';
import type { ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';

export interface ServeShellOptions {
  /** The Brewery's checkout: the state branch's clone. */
  root: string;
  git: Git;
  out: (line: string) => void;
  /** Listens for a signal that stops serve; default `process.once`. */
  listen?: ListenForSignal;
  /** The command whose lines the state branch's own start with; default `serve`. */
  command?: string;
  /**
   * The sandbox check steps run in; default this machine's, through `execProcess` (ADR 0076). A
   * repository's setup runs in the same sandbox with the network kept (ADR 0158).
   */
  checks?: Partial<SandboxedChecksOptions>;
  /**
   * How this machine is kept awake while an attempt runs, and the process the helper watches
   * (ADR 0195); absent, nothing holds it. The helper starts through `exec`, default `execProcess`.
   */
  keepAwake?: { mechanism: AwakeMechanism; pid: number; exec?: ExecProcess };
}

/** Where a process listens for signals: `process` itself. */
export interface SignalSource {
  on(name: NodeJS.Signals, handler: () => void): unknown;
  off(name: NodeJS.Signals, handler: () => void): unknown;
}

/** Listens for the stop signals while serve runs, until `stop`. */
export const listenWhileServing = (
  source: SignalSource,
): { listen: ListenForSignal; stop: () => void } => {
  // `on`, not `once`: a second Ctrl+C or a closed terminal while serve shuts down would
  // otherwise end the process before the driver stopped its runs.
  const listening: [NodeJS.Signals, () => void][] = [];
  return {
    listen: (name, handler) => {
      listening.push([name, handler]);
      source.on(name, handler);
    },
    stop: () => {
      for (const [name, handler] of listening.splice(0)) source.off(name, handler);
    },
  };
};

export const serveShell = (setup: ServeSetup, options: ServeShellOptions): ServeShell => {
  const { root, git, out, listen, checks, keepAwake: awake, command = 'serve' } = options;
  const { workRoot } = setup;
  // A repository's setup installs, so its sandbox keeps the network (ADR 0158).
  const setupExec = sandboxedChecks({ exec: execProcess, ...checks, network: true });
  // The repository on GitHub, where its pull request goes: every fetch, push and ls-remote reaches
  // it by this URL, never through the clone's configuration (ADR 0090, ADR 0096).
  const ownRemote = (repo: string): OwnRemote => ({
    url: `https://github.com/${repo}.git`,
    root: ownGitDirsRoot(workRoot, repo),
  });
  return {
    out,
    // Ctrl+C, a kill, a closed terminal, Ctrl+Break: each stops the runs through the driver, whose
    // brewers lead process groups of their own that a terminal's signal does not reach.
    signal: stopOnSignals(listen),
    clock: () => new Date(),
    wait: (ms, signal) => sleep(ms, undefined, { signal }).catch(() => {}),
    lock: lockDriver,
    openStore: (path) => {
      mkdirSync(dirname(path), { recursive: true });
      return openSqliteEventStore(path);
    },
    stateBranch: (store) =>
      openStateBranch({
        store,
        git,
        clone: root,
        worktree: setup.stateWorktree,
        out: (line) => out(`foedrum ${command}: ${line}`),
      }),
    worktrees: async (repository) => {
      const { repo, source, clone } = repository;
      if (source === 'local') {
        return openAttemptWorktrees({
          git,
          workRoot,
          repo,
          clone: worktreeClonePath(workRoot, repository),
          own: ownRemote(repo),
        });
      }
      const managed = await ensureManagedClone({
        git,
        workRoot,
        repo,
        url: `https://github.com/${repo}.git`,
        ...(clone === undefined ? {} : { reference: clone }),
      });
      return openAttemptWorktrees({ git, workRoot, repo, clone: managed, own: ownRemote(repo) });
    },
    // From the objects of the clone the worktrees are added to.
    push: (repository) =>
      openBranchPush({
        git,
        clone: worktreeClonePath(workRoot, repository),
        own: ownRemote(repository.repo),
      }),
    // In a git directory of its own with the clone's objects, as the base fetch (ADR 0198).
    mergeTree: (repository) =>
      openMergeTree({
        git,
        clone: worktreeClonePath(workRoot, repository),
        own: ownRemote(repository.repo),
      }),
    // A worktree of the merged tree from such a directory, for the checks on it (ADR 0203).
    mergedTree: (repository) =>
      openMergedTree({
        git,
        clone: worktreeClonePath(workRoot, repository),
        own: ownRemote(repository.repo),
      }),
    // In the worktree of the check attempt, git as the engine's calls in the clone (ADR 0137).
    merge: (repository) =>
      openWorktreeMerge({ git, clone: worktreeClonePath(workRoot, repository) }),
    // A brewer attempt's setup runs before claude, in the setup's sandbox (ADR 0163).
    runner: (claude, plan) => claudeBrewerRunner({ claude, plan, setup: setupExec }),
    // A check's command line runs in the OS sandbox (ADR 0076).
    exec: sandboxedChecks({ exec: execProcess, ...checks }),
    setup: setupExec,
    gh: execProcess,
    git,
    // The helper watches Foedrum's process, so a killed Foedrum lets the hold go (ADR 0195).
    ...(awake === undefined
      ? {}
      : {
          awake: keepAwake({
            command: setup.keepAwake ? awakeCommand(awake.mechanism, awake.pid) : undefined,
            exec: awake.exec ?? execProcess,
            cwd: root,
          }),
        }),
  };
};
