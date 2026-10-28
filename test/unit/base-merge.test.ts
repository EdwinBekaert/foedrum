// The base a batch's latest merge brought in (ADR 0164), read from the ledger: a merge whose
// conflicts a brewer concluded counts as the base merged at its tip (ADR 0244). Pure.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseMergeKey, mergedBase } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';

const keyOf = (attempt: number): string =>
  effectKey.encode(baseMergeKey({ batchId: 'b1', stepId: 'implement', attempt }));

describe('mergedBase', () => {
  it('counts a kept merge as the base merged at its tip, the latest winning', () => {
    const kept = 'e'.repeat(40);
    const effects = new Map<string, unknown>([
      [keyOf(1), { base: 'a'.repeat(40), merged: 'c'.repeat(40) }],
      [
        keyOf(2),
        { base: kept, kept: { files: [{ path: 'a.ts', status: 'both modified' }], more: 0 } },
      ],
    ]);
    assert.equal(mergedBase({ ...fold([]), effects }, 'b1'), kept);
  });
});
