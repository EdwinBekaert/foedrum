// `foedrum serve`'s shell on the real machine (ADR 0063): the lock, the store, the state branch,
// each repository's attempt worktrees (a local clone, or a managed clone made from GitHub), the
// claude runner, and the signals that stop it. git comes in, so its use is tested with a fake.

import type { ListenForSignal } from '../platform/processes.ts';
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

export const serveShell = (_setup: ServeSetup, _options: ServeShellOptions): ServeShell => {
  throw new Error('not implemented');
};
