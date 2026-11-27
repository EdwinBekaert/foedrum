// What the status comment says under a failed check and a Stuck batch (ADR 0428): the cases where
// it says nothing, which the route the engine took decides.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Attempt, Batch, Step } from '../../src/engine/fold.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';

const at = '2026-10-18T09:00:00.000Z';
const recipeSteps = ['implement', 'green', 'taste'];

const finished = (attempt: number, fields: Partial<Attempt> = {}): Attempt =>
  ({
    phase: 'finished',
    attempt,
    deadlineAt: at,
    outcome: {
      kind: 'failed',
      retryable: true,
      reason: 'the check "test" failed with exit code 1',
    },
    ...fields,
  }) as Attempt;

const step = (id: string, ...attempts: Attempt[]): [string, Step] => [
  id,
  { id, attempts: new Map(attempts.map((each) => [each.attempt, each])), inputs: [] },
];

const batch = (fields: Partial<Batch>): Batch => ({
  id: '7-1',
  issue: 7,
  recipe: { name: 'nip', reason: 'label', source: 'label' },
  lane: { kind: 'brewing' },
  steps: new Map(),
  rewinds: [],
  ...fields,
});

describe('renderStatus: what follows a failed check says nothing the route did not take (ADR 0428)', () => {
  it('names no next step for a failed check that ends the path', () => {
    const text = renderStatus(
      batch({
        steps: new Map([step('green', finished(1))]),
        path: [{ stepId: 'green', attempt: 1 }],
      }),
      recipeSteps,
    );
    assert.match(text, /- ❌ `green`: attempt 1 failed/);
    assert.doesNotMatch(text, /next:/);
  });

  it('names no next step when the attempt after it on the path was not scheduled from it', () => {
    const text = renderStatus(
      batch({
        steps: new Map([
          step('green', finished(1)),
          step('implement', finished(2, { route: { from: 'taste', why: 'findings' } })),
        ]),
        path: [
          { stepId: 'green', attempt: 1 },
          { stepId: 'implement', attempt: 2 },
        ],
      }),
      recipeSteps,
    );
    assert.doesNotMatch(text, /next:/);
  });

  it('names no next step when its retry follows it on the path', () => {
    const text = renderStatus(
      batch({
        steps: new Map([step('green', finished(1), finished(2, { retry: true }))]),
        path: [
          { stepId: 'green', attempt: 1 },
          { stepId: 'green', attempt: 2 },
        ],
      }),
      recipeSteps,
    );
    assert.doesNotMatch(text, /next:/);
  });

  it('lists no passed check of a Stuck step whose latest attempt is still running', () => {
    const text = renderStatus(
      batch({
        lane: {
          kind: 'stuck',
          reason: {
            kind: 'attempts_exhausted',
            stepId: 'green',
            attempts: 1,
            lastReason: 'the check "test" failed with exit code 1',
          },
          options: ['retry', 'cancel'],
          remindAt: at,
        },
        steps: new Map([
          step('green', finished(1), { phase: 'started', attempt: 2, deadlineAt: at }),
        ]),
      }),
      recipeSteps,
    );
    assert.match(text, /`green` ran 2 times in all and has no attempt left/);
    assert.doesNotMatch(text, /Passed:/);
  });
});
