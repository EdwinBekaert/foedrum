// Where a person sees the Cellarer (ADR 0380): the status comment's line of a finished Cellarer
// step says what it did, and foedrum status names it while it works.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeLane } from '../../src/cli/status.ts';
import type { Attempt, Batch } from '../../src/engine/fold.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import type { CellarerOutput } from '../../src/schemas/cellarer.ts';

const deadlineAt = '2026-11-11T14:00:00.000Z';
const finished = (attempt: number, output: CellarerOutput): Attempt => ({
  phase: 'finished',
  attempt,
  deadlineAt,
  outcome: { kind: 'succeeded', output },
});
const cleanup = (steps: Record<string, Attempt>, lane: Batch['lane']): Batch => ({
  id: '9-20261111120000',
  issue: 9,
  recipe: { name: 'cleanup', reason: 'label', source: 'label', type: 'tend' },
  lane,
  steps: new Map(
    Object.entries(steps).map(([id, attempt]) => [
      id,
      { id, attempts: new Map([[attempt.attempt, attempt]]), inputs: [] },
    ]),
  ),
  rewinds: [],
});

describe('the Cellarer on the status comment (ADR 0380)', () => {
  it("names the Cellarer and what it did on each of its finished steps' lines", () => {
    const text = renderStatus(
      cleanup(
        {
          shelve: finished(1, { cellarer: 'shelve', batches: ['1-1', '2-1', '3-1'] }),
          sweep: finished(1, {
            cellarer: 'sweep',
            removed: ['a', 'b'],
            failed: [{ name: 'c', error: 'EBUSY' }],
          }),
          expire: finished(1, { cellarer: 'expire', before: '2026-05' }),
        },
        { kind: 'on_tap', pullRequests: [] },
      ),
    );
    assert.match(text, /^- ✅ `shelve`: the Cellarer shelved 3 finished batches$/m);
    assert.match(
      text,
      /^- ✅ `sweep`: the Cellarer swept 2 old entries of \.foedrum\/tmp\/, and could not remove 1$/m,
    );
    assert.match(text, /^- ✅ `expire`: the Cellarer expired the shelf's months before 2026-05$/m);
  });

  it('says one batch and one entry in the singular, and none', () => {
    const text = renderStatus(
      cleanup(
        {
          shelve: finished(1, { cellarer: 'shelve', batches: ['1-1'] }),
          sweep: finished(1, { cellarer: 'sweep', removed: [], failed: [] }),
        },
        { kind: 'on_tap', pullRequests: [] },
      ),
    );
    assert.match(text, /^- ✅ `shelve`: the Cellarer shelved 1 finished batch$/m);
    assert.match(text, /^- ✅ `sweep`: the Cellarer swept no old entries of \.foedrum\/tmp\/$/m);
  });
});

describe('the Cellarer on foedrum status (ADR 0380)', () => {
  it('names the Cellarer at the step it works on', () => {
    const started: Attempt = { phase: 'started', attempt: 1, deadlineAt };
    assert.deepStrictEqual(describeLane(cleanup({ shelve: started }, { kind: 'brewing' }), '9'), {
      lane: 'brewing',
      detail: 'the Cellarer at shelve #1',
    });
  });
});
