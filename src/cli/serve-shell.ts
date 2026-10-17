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
import { type ListenForSignal, stopOnSignals } from '../platform/processes.ts';
import { ensureManagedClone, openAttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import type { Git } from '../workspace/git.ts';
import type { ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';

export interface ServeShellOptions {
  /** The Brewery's checkout: the state branch's clone. */
  root: string;
  git: Git;
  out: (line: string) => void;
  /** Listens for a signal that stops serve; default `process.once`. */
  listen?: ListenForSignal;
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
  const { root, git, out, listen } = options;
  const { workRoot } = setup;
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
      openStateBranch({ store, git, clone: root, worktree: setup.stateWorktree }),
    worktrees: async ({ repo, source, clone }) => {
      if (source === 'local') {
        // serveSetup refuses a local repository without its clone.
        return openAttemptWorktrees({ git, workRoot, repo, clone: clone ?? '' });
      }
      const managed = await ensureManagedClone({
        git,
        workRoot,
        repo,
        url: `https://github.com/${repo}.git`,
        ...(clone === undefined ? {} : { reference: clone }),
      });
      return openAttemptWorktrees({ git, workRoot, repo, clone: managed });
    },
    runner: (claude, plan) => claudeBrewerRunner({ claude, plan }),
  };
};
