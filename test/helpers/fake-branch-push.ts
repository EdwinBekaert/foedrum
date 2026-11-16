// A fake of a repository's branch push for tests (ADR 0021): the task tree at FAKE_COMMIT, the
// base elsewhere, no remote branch, nothing that looks like a secret, no file. A test gives only
// the members it needs to differ.

import type { BranchPush } from '../../src/engine/pull-request-actions.ts';
import { FAKE_COMMIT } from './fake-worktrees.ts';

export const fakeBranchPush = (overrides: Partial<BranchPush> = {}): BranchPush => ({
  commit: async () => FAKE_COMMIT,
  baseTip: async () => 'b'.repeat(40),
  isAncestor: async (commit, of) => commit === of,
  remoteTip: async () => undefined,
  push: async () => {},
  secretScan: async () => [],
  touchedFiles: async () => [],
  fileAt: async () => undefined,
  ...overrides,
});
