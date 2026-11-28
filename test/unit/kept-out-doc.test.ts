// Where the state branch keeps the out doc a step input reads once the worktrees are cleaned
// (ADR 0465).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keptOutDocOf } from '../../src/brewers/attempt-plan.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const deadlineAt = '2026-10-17T13:00:00.000Z';
const at = (attempt: number) => ({ batchId: '12-1', stepId: 'gauge', attempt });

const ordered: Event = {
  type: 'batch.ordered',
  batchId: '12-1',
  order: { issue: 12 },
  routeBy: deadlineAt,
};

const ran = (attempt: number, kind: 'succeeded' | 'failed'): Event[] => [
  { type: 'step.scheduled', ...at(attempt), deadlineAt },
  { type: 'step.started', ...at(attempt) },
  {
    type: 'step.finished',
    ...at(attempt),
    outcome:
      kind === 'succeeded'
        ? { kind, output: null }
        : { kind, reason: 'the brewer failed', retryable: true },
  },
];

const batchOf = (events: Event[]) => {
  const batch = fold([ordered, ...events]).batches.get('12-1');
  assert.ok(batch);
  return batch;
};

describe('keptOutDocOf (ADR 0465)', () => {
  it('is the place of the latest attempt that succeeded, not of a later one that failed', () => {
    const batch = batchOf([...ran(1, 'succeeded'), ...ran(2, 'succeeded'), ...ran(3, 'failed')]);
    assert.equal(keptOutDocOf(batch, 'gauge'), 'batches/12-1/gauge-2.md');
  });

  it('refuses a step no attempt of which succeeded: there is no copy to read', () => {
    const batch = batchOf(ran(1, 'failed'));
    assert.throws(() => keptOutDocOf(batch, 'gauge'), /Invalid attempt 0/);
  });
});
