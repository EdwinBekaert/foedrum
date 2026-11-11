// The mark of a batch that keeps failing in the state machine (ADR 0335): `decide` and `admit`
// refuse what cannot be marked, the mark changes no lane, and a person's way out of its Stuck takes
// it off.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admit } from '../../src/engine/admit.ts';
import { type Command, decide, type Ending, stuckOptions } from '../../src/engine/decide.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { batchEnded, emptyState, fold, type State } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';

const now = new Date('2026-11-06T12:00:00.000Z');
const since = '2026-11-06T11:00:00.000Z';
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const pullRequest = 'https://github.com/acme/api/pull/7';
const recipes = fakeRecipes({
  pint: fakeRecipe({ steps: ['plan', 'implement'] }),
  stout: fakeRecipe({ steps: ['draft'] }),
  group: fakeRecipe({ steps: ['lenses'], groups: { lenses: ['first', 'second'] } }),
});
const context = { now, recipes, reminderMs: 1_000, routingMs: 1_000 };
const who = { by: 'ada', via: 'terminal' } as const;
const mark = {
  kind: 'mark_failing',
  batchId: 'b1',
  pass: 'supervisor',
  summary: 'boom',
  since,
  reading: true,
} as const;

/** Applies each command on the state before it, every one accepted. */
const after = (commands: readonly Command[], state: State = emptyState): State => {
  let current = state;
  for (const command of commands) {
    const decision = decide(current, command, context);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    if (decision.kind === 'accepted') current = fold(decision.events, current);
  }
  return current;
};
const ordered: Command = { kind: 'order', batchId: 'b1', order: { issue: 1 } };
const routed = (recipe = 'pint'): Command => ({
  kind: 'route',
  batchId: 'b1',
  recipe,
  reason: 'label',
  source: 'label',
});
const brewing = (recipe = 'pint'): State => after([ordered, routed(recipe)]);
const typesOf = (state: State, command: Command): string[] => {
  const decision = decide(state, command, context);
  assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  return decision.kind === 'accepted' ? decision.events.map(({ type }) => type) : [];
};
const stuckOnFailing = (recipe?: string): State => after([mark], brewing(recipe));
const laneOf = (state: State) => state.batches.get('b1')?.lane;
const failingOf = (state: State) => state.batches.get('b1')?.failing;
const onTap = (): State => {
  const ref = { batchId: 'b1', stepId: 'draft', attempt: 1 };
  const ending: Ending = {
    kind: 'succeeded',
    output: { status: 'done', summary: 'Done', assumptions: [] },
  };
  return after([
    ordered,
    routed('stout'),
    { kind: 'record', event: { type: 'step.started', ...ref } },
    { kind: 'finish', ...ref, ending },
  ]);
};

describe('mark_failing', () => {
  it('marks a brewing batch and makes it Stuck on its running step, in one decision', () => {
    assert.deepStrictEqual(typesOf(brewing(), mark), ['batch.failing', 'batch.stuck']);
    const lane = laneOf(after([mark], brewing()));
    assert.deepStrictEqual(lane?.kind === 'stuck' ? lane.reason : undefined, {
      kind: 'failing',
      stepId: 'plan',
      pass: 'supervisor',
      summary: 'boom',
      since,
    });
  });

  it('abandons every child of a parallel group, as any Stuck does', () => {
    const state = after([mark], brewing('group'));
    const steps = state.batches.get('b1')?.steps;
    for (const child of ['first', 'second']) {
      const attempt = steps?.get(child)?.attempts.get(1);
      assert.ok(attempt?.phase === 'scheduled' && attempt.abandoned === true, child);
    }
  });

  it('marks a brewing batch and leaves its lane when no reading failed', () => {
    const state = brewing();
    assert.deepStrictEqual(typesOf(state, { ...mark, reading: false }), ['batch.failing']);
    assert.equal(laneOf(after([{ ...mark, reading: false }], state))?.kind, 'brewing');
  });

  it('marks a brewing batch with no running attempt alone, since a retry has nothing to schedule', () => {
    const stuck = after([{ kind: 'stop', order: { issue: 1 }, ...who }], brewing());
    const between = fold(
      [{ type: 'batch.resumed', batchId: 'b1', action: 'answer', ...who }],
      stuck,
    );
    assert.equal(laneOf(between)?.kind, 'brewing');
    assert.deepStrictEqual(typesOf(between, mark), ['batch.failing']);
    assert.equal(laneOf(after([mark], between))?.kind, 'brewing');
  });

  it("leaves an interactive session's person at work: the mark alone", () => {
    const state = fold(
      [
        {
          type: 'step.started',
          batchId: 'b1',
          stepId: 'plan',
          attempt: 1,
          interactiveSince: since,
        },
      ],
      brewing(),
    );
    assert.deepStrictEqual(typesOf(state, mark), ['batch.failing']);
  });

  it('marks a batch on tap and leaves its lane', () => {
    assert.deepStrictEqual(typesOf(onTap(), mark), ['batch.failing']);
  });

  it('marks a Stuck batch and leaves its reason', () => {
    const state = after([{ kind: 'stop', order: { issue: 1 }, ...who }], brewing());
    const before = laneOf(state);
    assert.deepStrictEqual(typesOf(state, mark), ['batch.failing']);
    assert.deepStrictEqual(laneOf(after([mark], state)), before);
  });

  it('reopens a cancelled batch whose effects keep failing, Stuck with the end a retry returns to', () => {
    const state = after([{ kind: 'cancel', batchId: 'b1', ...who }], brewing());
    assert.deepStrictEqual(typesOf(state, mark), ['batch.failing', 'batch.stuck']);
    const lane = laneOf(after([mark], state));
    assert.deepStrictEqual(lane?.kind === 'stuck' ? lane.reason.kind : lane?.kind, 'reopened');
    assert.deepStrictEqual(lane?.kind === 'stuck' ? lane.reason : undefined, {
      kind: 'reopened',
      ended: { kind: 'cancelled', ...who },
      pass: 'supervisor',
      summary: 'boom',
      since,
    });
  });

  it('a failure after the close that needs more work reopens the batch with a failing state', () => {
    const merged = after(
      [
        {
          kind: 'record',
          event: { type: 'pull_request.ended', batchId: 'b1', pullRequest, state: 'merged' },
        },
        {
          kind: 'record',
          event: {
            type: 'effect.applied',
            key: effectKey.encode({ batchId: 'b1', effect: 'status.1' }),
            result: { comment: 5, digest: '0123456789abcdef' },
          },
        },
      ],
      onTap(),
    );
    const ended = merged.batches.get('b1');
    assert.ok(ended !== undefined && batchEnded(ended) && ended.endShown === true);

    const reopened = after([mark], merged);
    const batch = reopened.batches.get('b1');
    assert.deepStrictEqual(batch?.lane, {
      kind: 'stuck',
      reason: {
        kind: 'reopened',
        ended: { kind: 'on_tap', pullRequests: [pullRequest] },
        pass: 'supervisor',
        summary: 'boom',
        since,
      },
      options: ['retry', 'cancel'],
      remindAt: new Date(now.getTime() + context.reminderMs).toISOString(),
    });
    assert.deepStrictEqual(batch?.failing, { pass: 'supervisor', summary: 'boom', since });
    // Its status comment takes revisions again, and nothing counts it ended.
    assert.equal(batch?.endShown, undefined);
    assert.equal(batchEnded(batch ?? assert.fail()), false);
  });

  it('a retry of a reopened batch returns it to how it ended, and its mark goes', () => {
    const state = after([{ kind: 'cancel', batchId: 'b1', ...who }], brewing());
    const retried = after([mark, { kind: 'retry', batchId: 'b1', ...who }], state);
    assert.deepStrictEqual(laneOf(retried), { kind: 'cancelled', ...who });
    assert.equal(failingOf(retried), undefined);
  });

  it('admits a reopened Stuck only of an ended batch, or again as its reminder: regression test (ADR 0380)', () => {
    const reopened: Event = {
      type: 'batch.stuck',
      batchId: 'b1',
      reason: {
        kind: 'reopened',
        ended: { kind: 'cancelled', ...who },
        pass: 'supervisor',
        summary: 'boom',
        since,
      },
      options: ['retry', 'cancel'],
      remindAt: since,
    };
    assert.equal(admit(brewing(), [reopened]).kind, 'refused');
    const cancelled = after([{ kind: 'cancel', batchId: 'b1', ...who }], brewing());
    assert.equal(admit(cancelled, [reopened]).kind, 'accepted');
    assert.equal(admit(after([mark], cancelled), [reopened]).kind, 'accepted');
    assert.equal(admit(emptyState, [reopened]).kind, 'refused');
  });

  it('refuses a skip of a reopened batch, which has no step to skip: regression test (ADR 0380)', () => {
    const reopened = after([mark], after([{ kind: 'cancel', batchId: 'b1', ...who }], brewing()));
    const skip = decide(reopened, { kind: 'skip', batchId: 'b1', ...who }, context);
    assert.equal(skip.kind, 'refused');
  });

  it('refuses a batch that was never ordered, and throws nothing', () => {
    assert.equal(decide(emptyState, mark, context).kind, 'refused');
  });

  it('makes a marked batch that brews Stuck, with no second mark', () => {
    const marked = after([{ ...mark, reading: false }], brewing());
    assert.deepStrictEqual(typesOf(marked, mark), ['batch.stuck']);
  });

  it('refuses a marked batch with nothing more to say', () => {
    const marked = after([mark], onTap());
    assert.equal(decide(marked, mark, context).kind, 'refused');
  });
});

describe('admit', () => {
  const failing: Event = {
    type: 'batch.failing',
    batchId: 'b1',
    pass: 'effects',
    summary: 's',
    since,
  };
  const recovered: Event = { type: 'batch.recovered', batchId: 'b1' };

  it('refuses a second mark', () => {
    assert.equal(admit(after([mark], onTap()), [failing]).kind, 'refused');
  });

  it('refuses a recovery with no mark', () => {
    assert.equal(admit(onTap(), [recovered]).kind, 'refused');
  });

  it('refuses a mark of a batch never ordered', () => {
    assert.equal(admit(emptyState, [failing]).kind, 'refused');
  });

  it('refuses a recovery of a batch never ordered', () => {
    assert.equal(admit(emptyState, [recovered]).kind, 'refused');
  });

  it('takes a summary of 120 characters and refuses a longer one', () => {
    assert.equal(admit(onTap(), [{ ...failing, summary: 'x'.repeat(120) }]).kind, 'accepted');
    assert.equal(admit(onTap(), [{ ...failing, summary: 'x'.repeat(121) }]).kind, 'refused');
  });

  it('takes a recovery of a marked batch', () => {
    assert.equal(admit(after([mark], onTap()), [recovered]).kind, 'accepted');
  });
});

describe('the mark in the fold', () => {
  it('carries the pass, the summary and since when', () => {
    assert.deepStrictEqual(failingOf(after([mark], onTap())), {
      pass: 'supervisor',
      summary: 'boom',
      since,
    });
  });

  it('goes with a recovery, and the lane stays', () => {
    const state = after(
      [{ kind: 'record', event: { type: 'batch.recovered', batchId: 'b1' } }],
      after([mark], onTap()),
    );
    assert.equal(failingOf(state), undefined);
    assert.equal(laneOf(state)?.kind, 'on_tap');
  });

  it('stays through the records of an open pull request', () => {
    const state = after(
      [
        {
          kind: 'record',
          event: {
            type: 'pull_request.base_checked',
            batchId: 'b1',
            pullRequest: 'https://github.com/acme/api/pull/7',
            branch: 'main',
            tip: SHA,
          },
        },
      ],
      after([mark], onTap()),
    );
    assert.notEqual(failingOf(state), undefined);
  });

  it('stays while a batch is cancelled', () => {
    const state = after([{ kind: 'cancel', batchId: 'b1', ...who }], stuckOnFailing());
    assert.notEqual(failingOf(state), undefined);
  });
});

describe('a person takes a batch out of its Stuck on failing', () => {
  it('offers what a stalled batch offers', () => {
    const reason = { kind: 'failing', stepId: 'plan', pass: 'drive', summary: 's', since } as const;
    assert.deepStrictEqual(stuckOptions(reason), ['retry', 'skip', 'recipe', 'rewind', 'cancel']);
  });

  it('a retry schedules its step again with a new deadline, and the mark goes', () => {
    const later = new Date(now.getTime() + 60_000);
    const retry = { kind: 'retry', batchId: 'b1', ...who } as const;
    const decision = decide(stuckOnFailing(), retry, { ...context, now: later });
    assert.ok(decision.kind === 'accepted', JSON.stringify(decision));
    const state = fold(decision.events, stuckOnFailing());
    assert.equal(laneOf(state)?.kind, 'brewing');
    const attempt = state.batches.get('b1')?.steps.get('plan')?.attempts.get(2);
    assert.equal(attempt?.phase, 'scheduled');
    assert.equal(attempt?.deadlineAt, new Date(later.getTime() + hour).toISOString());
    assert.equal(failingOf(state), undefined);
  });

  it('a retry of a parallel group schedules its children again', () => {
    const state = after([{ kind: 'retry', batchId: 'b1', ...who }], stuckOnFailing('group'));
    const steps = state.batches.get('b1')?.steps;
    assert.equal(steps?.get('first')?.attempts.get(2)?.phase, 'scheduled');
    assert.equal(steps?.get('second')?.attempts.get(2)?.phase, 'scheduled');
  });

  it('a skip goes on and the mark goes', () => {
    const state = after([{ kind: 'skip', batchId: 'b1', ...who }], stuckOnFailing());
    assert.equal(laneOf(state)?.kind, 'brewing');
    assert.equal(failingOf(state), undefined);
  });

  it('another recipe starts and the mark goes', () => {
    const command = {
      kind: 'recipe',
      batchId: 'b1',
      recipe: 'stout',
      reason: 'r',
      ...who,
    } as const;
    const state = after([command], stuckOnFailing());
    assert.equal(laneOf(state)?.kind, 'brewing');
    assert.equal(failingOf(state), undefined);
  });

  it('a rewind goes back and the mark goes', () => {
    const command = {
      kind: 'rewind',
      batchId: 'b1',
      toStepId: 'plan',
      shas: { 'acme/api': SHA },
      ...who,
    } as const;
    const state = after([command], stuckOnFailing());
    assert.equal(laneOf(state)?.kind, 'brewing');
    assert.equal(failingOf(state), undefined);
  });

  it('a person moving a batch Stuck for another reason leaves its mark', () => {
    const stopped = after([{ kind: 'stop', order: { issue: 1 }, ...who }], brewing());
    const state = after([mark, { kind: 'retry', batchId: 'b1', ...who }], stopped);
    assert.equal(laneOf(state)?.kind, 'brewing');
    assert.notEqual(failingOf(state), undefined);
  });
});
