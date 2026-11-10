// The base a batch's latest merge brought in (ADR 0164), read from the ledger: a merge whose
// conflicts a brewer concluded counts as the base merged at its tip (ADR 0244); and why a done
// with that merge unconcluded fails; and the merge at the start of a routed fix, on a scripted
// worktree. Pure.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BaseMerge,
  baseMergeKey,
  baseMergeTarget,
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
  started: Partial<Extract<Event, { type: 'step.started' }>> = {},
): Event[] => [
  {
    type: 'step.scheduled',
    ...ref(attempt),
    deadlineAt,
    ...(attempt === 1 ? {} : { retry: true }),
  },
  { type: 'step.started', ...ref(attempt), ...started },
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

  it('counts the kept merge of a resumed attempt that a later resume of its session carried on', () => {
    const session = '0f8fad5b-d9cb-469f-a165-708677289500';
    const path = '/work/implement-1';
    const worktree = { repo: 'acme/app', path, branch: 'foedrum/b1/implement/1', commit: first };
    const resumes = { session: { id: session, resumes: session, worktree: path } };
    const newer = 'f'.repeat(40);
    const state = fold([
      ...ordered,
      ...attempt(1, kept(tip), failed, { session: { id: session, worktree: path }, worktree }),
      // The first resume merged a newer tip in the same worktree, then failed.
      ...attempt(2, kept(newer), failed, resumes),
      ...attempt(3, { base: newer }, succeeded, resumes),
    ]);
    assert.equal(mergedBase(state, 'b1'), newer);
  });

  it("counts a merge commit whatever its attempt's outcome, as green's own while green runs", () => {
    const merged = { base: tip, merged: 'c'.repeat(40) };
    const running: Event[] = [
      { type: 'step.scheduled', ...ref(1), deadlineAt },
      { type: 'step.started', ...ref(1) },
      { type: 'effect.applied', key: effectKey.encode(baseMergeKey(ref(1))), result: merged },
    ];
    assert.equal(mergedBase(fold([...ordered, ...running]), 'b1'), tip);
    assert.equal(mergedBase(fold([...ordered, ...attempt(1, merged, failed)]), 'b1'), tip);
  });

  it('counts a kept merge that a retry resuming its session carried on to a success', () => {
    const session = '0f8fad5b-d9cb-469f-a165-708677289500';
    const path = '/work/implement-1';
    const worktree = { repo: 'acme/app', path, branch: 'foedrum/b1/implement/1', commit: first };
    const state = fold([
      ...ordered,
      ...attempt(1, kept(tip), failed, { session: { id: session, worktree: path }, worktree }),
      // The resumed attempt finds the tip in its HEAD already: nothing new to merge.
      ...attempt(2, { base: tip }, succeeded, {
        session: { id: session, resumes: session, worktree: path },
      }),
    ]);
    assert.equal(mergedBase(state, 'b1'), tip);
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

describe('baseMergeTarget, keeping a conflict at the start of a routed fix (ADR 0244)', () => {
  const start = 'a'.repeat(40);
  const tip = 'e'.repeat(40);
  const moved = '1'.repeat(40);
  const concluded = '2'.repeat(40);
  const after = '3'.repeat(40);
  const key = effectKey.encode(baseMergeKey(ref(2)));
  const files: KeptFile[] = [{ path: 'readme.txt', status: 'both modified' }];

  it('merges again from a HEAD that moved past the start without the merge, and finds nothing new once HEAD holds the tip', async () => {
    // A resumed worktree recreated on its branch: the brewer's commit after the start, no merge.
    let head = moved;
    const merges: string[] = [];
    const merge: BaseMerge = {
      base: 'main',
      push: {
        baseTip: async () => tip,
        // Only the commits after the brewer concluded the merge hold the tip.
        isAncestor: async (commit, of) => commit === tip && (of === concluded || of === after),
      },
      worktree: {
        head: async () => head,
        parents: async (_path, commit) =>
          ({ [moved]: [start], [concluded]: [moved, tip], [after]: [concluded] })[commit] ?? [],
        abort: async () => assert.fail('a kept merge is never aborted'),
        pending: async () => undefined,
        merge: async (_path, commit, _message, _signal, keep) => {
          merges.push(`${commit} into ${head}${keep === true ? ', kept' : ''}`);
          return { kind: 'kept', files };
        },
      },
    };
    const target = () => baseMergeTarget(merge, { path: '/work/tree', start }, 'implement', true);
    assert.equal(await target().find(key), undefined);
    assert.deepEqual(await target().apply(key), { base: tip, kept: { files, more: 0 } });
    assert.deepEqual(merges, [`${tip} into ${moved}, kept`]);
    // Concluded, then one more commit: HEAD holds the tip, so nothing is merged.
    head = after;
    assert.equal(await target().find(key), undefined);
    assert.deepEqual(await target().apply(key), { base: tip });
    assert.deepEqual(merges, [`${tip} into ${moved}, kept`]);
  });
});
