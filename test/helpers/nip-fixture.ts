// The Nip fixture (#180, ADR 0121): a tiny target repository with one source file and one
// `node --test` test, a Brewery that brews with Nip from `defaults/` (ADR 0098), the order that
// routes to it, and the scripted Gauger and Cellarman that play it in serve's runner seam. Stubs
// until the fixture exists.

import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Git, GitOptions } from '../../src/workspace/git.ts';

/** The order: an issue of the Brewery, labelled for Nip. */
export const NIP_ORDER = { number: 1, title: '', body: '', labels: [] as string[] };

/** The target repository on main: one source file and its one test. */
export const NIP_TARGET_FILES: Readonly<Record<string, string>> = {};

/** One scripted attempt: the files it writes, its commit, and its out doc's summary. */
interface Scripted {
  files: Record<string, string>;
  message: string;
  summary: string;
}

/** What each attempt of a step commits, by step id and then attempt. */
export const NIP_SCRIPT: Readonly<Record<string, readonly Scripted[]>> = {};

/** The Brewery's files, by path relative to its checkout. */
export const nipBreweryFiles = (_options: {
  brewery: string;
  target: string;
  user: string;
}): Record<string, string> => {
  throw new Error('not implemented');
};

export interface ScriptedNipOptions {
  /** The attempt's plan, serve's own: its worktree and its prompt. */
  plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>;
  git: Git;
  /** The git configuration of the brewer's commits: who commits, no signing, no hooks. */
  config: NonNullable<GitOptions['config']>;
  write: (path: string, text: string) => void;
}

export interface ScriptedNip extends BrewerRunner {
  /** The prompt each attempt was planned with, by attempt key. */
  readonly prompts: ReadonlyMap<string, string>;
}

/** The scripted Gauger and Cellarman of `NIP_SCRIPT`, in serve's runner seam. */
export const scriptedNip = (_options: ScriptedNipOptions): ScriptedNip => {
  throw new Error('not implemented');
};
