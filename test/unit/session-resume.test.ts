// Which session a retry resumes (ADR 0117), from plain events: the one of the attempt before it,
// when claude started it and an attempt of it has a worktree; otherwise none, or fresh and why.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Batch, fold } from '../../src/engine/fold.ts';
import { ranIn, resumeOf } from '../../src/engine/session-resume.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';

const deadlineAt = '2026-10-22T13:00:00.000Z';
const claude = { version: '2.1.301', model: 'claude-sonnet-5-5' };
const id = (n: number) => `0f8fad5b-d9cb-469f-a165-70867728950${n}`;
const plan = (attempt: number) => ({ batchId: 'b1', stepId: 'plan', attempt });
const worktree = (attempt: number) => ({
  repo: 'acme/app',
  path: `work/b1/plan/${attempt}`,
  branch: `foedrum/b1/plan/${attempt}`,
  commit: 'c'.repeat(40),
});
const crashed: StepOutcome = { kind: 'failed', retryable: true, reason: 'crashed' };
const ordered: Event = {
  type: 'batch.ordered',
  batchId: 'b1',
  order: { issue: 1 },
  routeBy: deadlineAt,
};

/** Attempt `n` of plan, started fresh in a worktree of its own with session `id(n)`, finished. */
const fresh = (n: number, outcome: StepOutcome = crashed, retry = n > 1): Event[] => [
  { type: 'step.scheduled', ...plan(n), deadlineAt, ...(retry ? { retry: true } : {}) },
  {
    type: 'step.started',
    ...plan(n),
    session: { id: id(n), worktree: worktree(n).path },
    worktree: worktree(n),
  },
  { type: 'step.finished', ...plan(n), outcome, claude },
];
const scheduled = (n: number, retry = true): Event => ({
  type: 'step.scheduled',
  ...plan(n),
  deadlineAt,
  ...(retry ? { retry: true } : {}),
});
const batchOf = (events: Event[]): Batch => {
  const batch = fold([ordered, ...events]).batches.get('b1');
  assert.ok(batch !== undefined);
  return batch;
};

describe('resumeOf', () => {
  it('resumes the session of the attempt before a retry, in the worktree that made it', () => {
    assert.deepStrictEqual(resumeOf(batchOf([...fresh(1), scheduled(2)]), plan(2)), {
      kind: 'resume',
      session: id(1),
      from: plan(1),
      worktree: worktree(1),
    });
  });

  it('has nothing to resume for an attempt that is no retry, or a first attempt', () => {
    assert.equal(resumeOf(batchOf([...fresh(1), scheduled(2, false)]), plan(2)), undefined);
    assert.equal(resumeOf(batchOf([scheduled(1, false)]), plan(1)), undefined);
  });

  it('has nothing to resume when the attempt before it ran no session, as a check step', () => {
    const noSession: Event[] = [
      { type: 'step.scheduled', ...plan(1), deadlineAt },
      { type: 'step.started', ...plan(1), worktree: worktree(1) },
      { type: 'step.finished', ...plan(1), outcome: crashed },
      scheduled(2),
    ];
    assert.equal(resumeOf(batchOf(noSession), plan(2)), undefined);
  });

  it('starts fresh after an attempt that Stuck abandoned: its process may still run', () => {
    const abandoned: Event[] = [
      fresh(1)[0] as Event,
      fresh(1)[1] as Event,
      {
        type: 'batch.stuck',
        batchId: 'b1',
        reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt },
        options: ['retry'],
        remindAt: deadlineAt,
      },
      scheduled(2),
    ];
    assert.deepStrictEqual(resumeOf(batchOf(abandoned), plan(2)), {
      kind: 'fresh',
      why: 'plan#1 has no session claude started',
    });
  });

  it('starts fresh when no attempt of the session it would resume has a worktree', () => {
    const resumedOnly: Event[] = [
      { type: 'step.scheduled', ...plan(1), deadlineAt },
      { type: 'step.started', ...plan(1), session: { id: id(1), resumes: id(1), worktree: 'w' } },
      { type: 'step.finished', ...plan(1), outcome: crashed, claude },
      scheduled(2),
    ];
    assert.deepStrictEqual(resumeOf(batchOf(resumedOnly), plan(2)), {
      kind: 'fresh',
      why: `no attempt of session ${id(1)} has a worktree`,
    });
  });
});

describe('ranIn', () => {
  it("gives an attempt its own worktree, and a resumed one the worktree of its session's maker", () => {
    // plan#1 ran a session of its own; plan#2 started fresh; plan#3 resumes plan#2's session.
    const batch = batchOf([
      ...fresh(1),
      ...fresh(2),
      scheduled(3),
      { type: 'step.started', ...plan(3), session: { id: id(2), resumes: id(2), worktree: 'w' } },
    ]);
    const step = batch.steps.get('plan');
    assert.ok(step !== undefined);
    const of = (n: number) => {
      const attempt = step.attempts.get(n);
      assert.ok(attempt !== undefined);
      return ranIn(step, attempt);
    };
    assert.deepStrictEqual(of(1), { attempt: 1, worktree: worktree(1) });
    assert.deepStrictEqual(of(3), { attempt: 2, worktree: worktree(2) });
  });
});
