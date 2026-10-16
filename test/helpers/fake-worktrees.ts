// A fake attempt worktree manager for engine tests: it records what the engine asks of it and
// makes no folder and runs no git (ADR 0021). The real one is tested in attempt-worktrees*.test.ts.

import { join } from 'node:path';
import type { AttemptRef, Claims } from '../../src/workspace/attempt-worktrees.ts';
import { attemptBranch, attemptFolder } from '../../src/workspace/attempt-worktrees.ts';
import type {
  AttemptWorktree,
  AttemptWorktrees,
  CleanReport,
} from '../../src/workspace/attempt-worktrees-git.ts';

export type WorktreeCall =
  | { kind: 'create'; ref: AttemptRef; base: string }
  | { kind: 'clean'; claims: Claims; scope: { batchId?: string } };

export interface FakeWorktreesOptions {
  /** The attempts root; default `work/acme.app/attempts`. */
  root?: string;
  /** The commit every new worktree is at. */
  commit?: string;
  /** Why `create` refuses this attempt, or undefined to make its worktree. */
  refuse?: (ref: AttemptRef) => string | undefined;
  /** Makes `clean` throw, as when git cannot list the worktrees. */
  cleanFails?: string;
}

export interface FakeWorktrees extends AttemptWorktrees {
  readonly calls: WorktreeCall[];
  /** The `clean` calls only. */
  cleans(): { claims: Claims; scope: { batchId?: string } }[];
}

export const FAKE_COMMIT = 'a'.repeat(40);

export const fakeWorktrees = (options: FakeWorktreesOptions = {}): FakeWorktrees => {
  const { root = join('work', 'acme.app', 'attempts'), commit = FAKE_COMMIT } = options;
  const calls: WorktreeCall[] = [];
  return {
    root,
    calls,
    cleans: () =>
      calls.flatMap((call) =>
        call.kind === 'clean' ? [{ claims: call.claims, scope: call.scope }] : [],
      ),
    async create(ref, base): Promise<AttemptWorktree> {
      calls.push({ kind: 'create', ref, base });
      const reason = options.refuse?.(ref);
      if (reason !== undefined) throw new Error(reason);
      const path = join(root, ...attemptFolder(ref).split('/'));
      return { path, branch: attemptBranch(ref), commit };
    },
    recreate: () => Promise.reject(new Error('the fake worktrees recreate nothing')),
    async clean(claims, scope = {}): Promise<CleanReport> {
      calls.push({ kind: 'clean', claims, scope });
      if (options.cleanFails !== undefined) throw new Error(options.cleanFails);
      return { done: [`cleaned ${root} ${scope.batchId ?? 'every batch'}`], kept: [], failed: [] };
    },
  };
};
