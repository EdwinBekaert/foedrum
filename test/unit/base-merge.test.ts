// The base a batch's latest merge brought in (ADR 0164), read from the ledger: a merge whose
// conflicts a brewer concluded counts as the base merged at its tip (ADR 0244); and why a done
// with that merge unconcluded fails. Pure.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BaseMerge,
  baseMergeKey,
  mergedBase,
  unconcludedMerge,
} from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { KeptFile } from '../../src/schemas/store.ts';

const deadlineAt = '2026-12-31T00:00:00.000Z';
const ref = (attempt: number) => ({ batchId: 'b1', stepId: 'implement', attempt });
const kept = (base: string) => ({
  base,
  kept: { files: [{ path: 'a.ts', status: 'both modified' }], more: 0 },
});
/** Attempt `attempt` of implement, its start merge recorded as `result`, ending `outcome`. */
const attempt = (
  attempt: number,
  result: unknown,
  outcome: Extract<Event, { type: 'step.finished' }>['outcome'],
): Event[] => [
  {
    type: 'step.scheduled',
    ...ref(attempt),
    deadlineAt,
    ...(attempt === 1 ? {} : { retry: true }),
  },
  { type: 'step.started', ...ref(attempt) },
  {
    type: 'effect.applied',
    key: effectKey.encode(baseMergeKey(ref(attempt))),
    result: result as null,
  },
  { type: 'step.finished', ...ref(attempt), outcome },
];
const ordered: Event[] = [
  { type: 'batch.ordered', batchId: 'b1', order: { issue: 1 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'nip', reason: 'label', source: 'label' },
];
const failed = { kind: 'failed', retryable: true, reason: 'the merge is not concluded' } as const;
const succeeded = { kind: 'succeeded', output: null } as const;

describe('mergedBase', () => {
  const first = 'a'.repeat(40);
  const tip = 'e'.repeat(40);

  it('counts a kept merge as the base merged at its tip, the latest winning', () => {
    const state = fold([
      ...ordered,
      ...attempt(1, { base: first, merged: 'c'.repeat(40) }, failed),
      ...attempt(2, kept(tip), succeeded),
    ]);
    assert.equal(mergedBase(state, 'b1'), tip);
  });

  it('never counts a kept merge whose attempt did not conclude it', () => {
    const state = fold([...ordered, ...attempt(1, kept(tip), failed)]);
    assert.equal(mergedBase(state, 'b1'), undefined);
  });
});

describe('unconcludedMerge', () => {
  const tip = 'e'.repeat(40);
  const merge = (files: KeptFile[]): BaseMerge => ({
    base: 'main',
    push: { baseTip: async () => tip, isAncestor: async () => false },
    worktree: {
      head: async () => 'a'.repeat(40),
      parents: async () => [],
      abort: async () => {},
      pending: async () => ({ tip, files }),
      merge: async () => ({ kind: 'kept', files }),
    },
  });

  it('names at most 50 of the files still unmerged, and how many more', async () => {
    const files: KeptFile[] = Array.from({ length: 52 }, (_, n) => ({
      path: `f${n}.ts`,
      status: 'both modified',
    }));
    const reason = await unconcludedMerge(merge(files), '/work/tree', {
      base: tip,
      kept: { files: [], more: 0 },
    });
    const named = files.slice(0, 50).map(({ path }) => path);
    assert.equal(
      reason,
      `the merge of main at ${tip} is still in progress, with ${named.join(', ')} and 2 more unmerged: resolve each file, git add it and git commit the merge`,
    );
  });
});
