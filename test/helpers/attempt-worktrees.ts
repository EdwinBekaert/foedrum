// Fakes and folders for the attempt worktree manager's shell tests (ADR 0021): a fake git that
// records every call, captured-shape git output, and temp folders made once per suite.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before } from 'node:test';
import type { AttemptRef } from '../../src/workspace/attempt-worktrees.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from './temp-dir.ts';

// One temp folder per suite, a fresh subfolder per test: removing a tree per test is slow on
// Windows under the load of a full check (ADR 0021's budget).
export const suiteFolders = (prefix: string): (() => string) => {
  let suite: TempDir | undefined;
  let count = 0;
  before(() => {
    suite = makeTempDir(prefix);
  });
  after(() => suite?.remove());
  return () => {
    count += 1;
    const path = join(suite?.path ?? '', String(count));
    mkdirSync(path);
    return path;
  };
};

export type Call = [cwd: string, ...args: string[]];
export type Answer = (cwd: string, args: readonly string[]) => GitResult | undefined;

export const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
export const failed = (stderr = 'fatal: simulated failure\n'): GitResult => ({
  code: 1,
  stdout: '',
  stderr,
});

// A fake git that records every call, and its options, and answers through `answer`, or with
// success; the git directory and object format, as rev-parse names them, are `<cwd>/.git` and
// SHA-1.
export const fakeGit = (answer: Answer = () => undefined) => {
  const calls: Call[] = [];
  const options: (GitOptions | undefined)[] = [];
  const git: Git = async (cwd, args, given) => {
    calls.push([cwd, ...args]);
    options.push(given);
    if (args.includes('--show-object-format')) return ok(`${join(cwd, '.git')}\nsha1\n`);
    return answer(cwd, args) ?? ok();
  };
  return { calls, options, git };
};

// `git worktree list --porcelain -z` output for the given worktrees.
export const porcelain = (worktrees: { path: string; branch?: string }[]): string =>
  worktrees
    .map(
      ({ path, branch }) =>
        `worktree ${path}\0HEAD ${'1'.repeat(40)}\0${branch === undefined ? 'detached' : `branch refs/heads/${branch}`}\0\0`,
    )
    .join('');

export const BASE = 'b'.repeat(40);
export const TIP = 'c'.repeat(40);
export const attempt: AttemptRef = { batchId: '12-1', stepId: 'implement', attempt: 1 };
export const branch = 'foedrum/12-1/implement/1';
