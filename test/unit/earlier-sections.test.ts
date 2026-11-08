// The earlier-sections input (#947): what a Cellarman's later attempt reads of the sections its
// earlier attempts wrote, folded from plain events. The planner's tests show the input in a prompt;
// these pin which attempt's sections it holds.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { earlierSectionsInput } from '../../src/engine/earlier-sections.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const deadlineAt = '2026-10-17T13:00:00.000Z';

const ordered: Event = {
  type: 'batch.ordered',
  batchId: '12-1',
  order: { issue: 12 },
  routeBy: deadlineAt,
};

/** The sections of a round: every marker carries the round's name, so a text shows whose it is. */
const sections = (round: string) => ({
  howItWorks: `How it works in the ${round} round.`,
  seeIt: `See it in the ${round} round.`,
  beforeAfter: [
    { case: `case of the ${round} round`, before: `before ${round}`, after: `after ${round}` },
  ],
});

/** Attempt `attempt` of `stepId` that succeeded with `fields` in its out doc, or failed. */
const run = (stepId: string, attempt: number, fields?: Record<string, unknown>): Event[] => {
  const ref = { batchId: '12-1', stepId, attempt };
  return [
    { type: 'step.scheduled', ...ref, deadlineAt },
    { type: 'step.started', ...ref },
    {
      type: 'step.finished',
      ...ref,
      outcome:
        fields === undefined
          ? { kind: 'failed', retryable: true, reason: 'claude crashed' }
          : {
              kind: 'succeeded',
              output: { status: 'done', summary: `Round ${attempt}`, assumptions: [], ...fields },
            },
    },
  ];
};

const inputOf = (events: Event[], stepId: string, attempt: number) => {
  const state = fold([ordered, ...events]);
  const batch = state.batches.get('12-1');
  assert.ok(batch);
  return earlierSectionsInput(batch, stepId, attempt);
};

describe('earlierSectionsInput (#947)', () => {
  it('gives the first attempt of a step no earlier sections', () => {
    assert.equal(inputOf(run('implement', 1), 'implement', 1), undefined);
  });

  it("gives a fix round the sections of the round before: how it works, see it and each row of before and after's table", () => {
    const input = inputOf(run('implement', 1, sections('first')), 'implement', 2);
    assert.equal(input?.attempt, 1);
    const text = input?.text ?? '';
    assert.match(text, /How it works in the first round\./);
    assert.match(text, /See it in the first round\./);
    assert.match(text, /case of the first round/);
    assert.match(text, /before first/);
    assert.match(text, /after first/);
  });

  it("gives a third round the second round's sections, which the second wrote for the whole change, not the first's", () => {
    const events = [
      ...run('implement', 1, sections('first')),
      ...run('implement', 2, sections('second')),
    ];
    const input = inputOf(events, 'implement', 3);
    assert.equal(input?.attempt, 2);
    assert.match(input?.text ?? '', /How it works in the second round\./);
    assert.doesNotMatch(input?.text ?? '', /first round/);
  });

  it('reads past an attempt that succeeded and wrote no sections', () => {
    const events = [...run('implement', 1, sections('first')), ...run('implement', 2, {})];
    const input = inputOf(events, 'implement', 3);
    assert.equal(input?.attempt, 1);
    assert.match(input?.text ?? '', /How it works in the first round\./);
  });

  it('reads past an attempt that failed', () => {
    const events = [...run('implement', 1, sections('first')), ...run('implement', 2)];
    const input = inputOf(events, 'implement', 3);
    assert.equal(input?.attempt, 1);
    assert.match(input?.text ?? '', /How it works in the first round\./);
  });

  it('gives no sections of an attempt that came after the one asking', () => {
    const events = [...run('implement', 1), ...run('implement', 2, sections('second'))];
    assert.equal(inputOf(events, 'implement', 1), undefined);
  });

  it('gives no sections of another step, however recent', () => {
    const events = [...run('other', 1, sections('other')), ...run('implement', 1)];
    assert.equal(inputOf(events, 'implement', 2), undefined);
  });

  it('gives an attempt that wrote only a how it works that section alone', () => {
    const input = inputOf(run('implement', 1, { howItWorks: 'Only this.' }), 'implement', 2);
    assert.match(input?.text ?? '', /Only this\./);
    assert.doesNotMatch(input?.text ?? '', /See it in/);
  });
});
