// A kept merge that a success concluded counts on the line to a head only when its base is held
// by that head (ADR 0244, ADR 0452): the record names no merge commit, so git is asked about the
// base. Pure, with a fake git answer.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseMergeKey, type MergeLine, mergedBaseOnLine } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const deadlineAt = '2026-12-31T00:00:00.000Z';
const ref = { batchId: 'b1', stepId: 'implement', attempt: 1 };
const base = 'e'.repeat(40);
const head = '1'.repeat(40);
const concluded: Event[] = [
  { type: 'batch.ordered', batchId: 'b1', order: { issue: 1 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'nip', reason: 'label', source: 'label' },
  { type: 'step.scheduled', ...ref, deadlineAt },
  { type: 'step.started', ...ref },
  {
    type: 'effect.applied',
    key: effectKey.encode(baseMergeKey(ref)),
    result: { base, kept: { files: [{ path: 'a.ts', status: 'both modified' }], more: 0 } },
  },
  { type: 'step.finished', ...ref, outcome: { kind: 'succeeded', output: null } },
];

describe('mergedBaseOnLine of a kept merge (ADR 0452)', () => {
  const lineOf = (heldBy: string) => {
    const asked: string[] = [];
    const line: MergeLine = {
      head,
      isAncestor: async (commit, of) => {
        asked.push(`${commit} of ${of}`);
        return commit === heldBy;
      },
    };
    return { line, asked };
  };

  it("counts it when the head holds its base, asking git about the base and the head's line", async () => {
    const { line, asked } = lineOf(base);
    assert.equal(await mergedBaseOnLine(fold(concluded), 'b1', line), base);
    assert.deepEqual(asked, [`${base} of ${head}`]);
  });

  it('passes over it when the head does not hold its base', async () => {
    const { line, asked } = lineOf('f'.repeat(40));
    assert.equal(await mergedBaseOnLine(fold(concluded), 'b1', line), undefined);
    assert.deepEqual(asked, [`${base} of ${head}`]);
  });
});
