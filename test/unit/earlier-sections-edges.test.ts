// The edges of the earlier-sections input (#947): a step no attempt of which has run, and
// sections without a how it works.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { earlierSectionsInput } from '../../src/engine/earlier-sections.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const deadlineAt = '2026-10-17T13:00:00.000Z';
const ref = { batchId: '12-1', stepId: 'implement', attempt: 1 };

const ordered: Event = {
  type: 'batch.ordered',
  batchId: '12-1',
  order: { issue: 12 },
  routeBy: deadlineAt,
};

const succeededWith = (fields: Record<string, unknown>): Event[] => [
  { type: 'step.scheduled', ...ref, deadlineAt },
  { type: 'step.started', ...ref },
  {
    type: 'step.finished',
    ...ref,
    outcome: {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Round 1', assumptions: [], ...fields },
    },
  },
];

const batchOf = (events: Event[]) => {
  const batch = fold([ordered, ...events]).batches.get('12-1');
  assert.ok(batch);
  return batch;
};

describe('earlierSectionsInput edges (#947)', () => {
  it('gives a step no attempt of which has run no earlier sections', () => {
    const batch = batchOf(succeededWith({ howItWorks: 'Something.' }));
    assert.equal(earlierSectionsInput(batch, 'never-run', 1), undefined);
  });

  it('puts the how it works under its own heading (regression test)', () => {
    const batch = batchOf(succeededWith({ howItWorks: 'Something.', beforeAfter: [] }));
    const text = earlierSectionsInput(batch, 'implement', 2)?.text ?? '';
    assert.match(text, /^## How it works\n\nSomething\.$/);
  });

  it('gives sections without a how it works their other sections alone', () => {
    const batch = batchOf(
      succeededWith({
        seeIt: 'Run it.',
        beforeAfter: [{ case: 'a case', before: 'was', after: 'is' }],
      }),
    );
    const text = earlierSectionsInput(batch, 'implement', 2)?.text ?? '';
    assert.match(text, /## See it\n\nRun it\./);
    assert.match(text, /## Before and after\n\n- a case: before: was; after: is/);
    assert.doesNotMatch(text, /How it works/);
  });
});
