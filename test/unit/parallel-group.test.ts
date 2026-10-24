// A recipe's parallel group in the state machine (ADR 0168): its children run side by side, and
// the group ends, with its verdict, once every child has ended.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Command, type Context, decide } from '../../src/engine/decide.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event, StuckOption, StuckReason } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';

const now = new Date('2026-10-15T12:00:00.000Z');
const inAnHour = '2026-10-15T13:00:00.000Z';
const earlier = '2026-10-15T11:00:00.000Z';
const by = { by: 'octocat', via: 'comment' } as const;

// Two lenses side by side after implement; correctness blocks and goes back to implement.
const context: Context = {
  now,
  reminderMs: 48 * hour,
  routingMs: hour,
  recipes: fakeRecipes({
    flight: fakeRecipe({
      steps: ['implement', 'tasting', 'polish'],
      groups: { tasting: ['correctness', 'security'] },
      routes: { correctness: { findings: 'implement' } },
    }),
  }),
};

type Scheduled = Extract<Event, { type: 'step.scheduled' }>;
const scheduled = (stepId: string, attempt = 1, deadlineAt = earlier): Scheduled => ({
  type: 'step.scheduled',
  batchId: 'b1',
  stepId,
  attempt,
  deadlineAt,
});
const next = (stepId: string, attempt = 1): Scheduled => scheduled(stepId, attempt, inAnHour);
const started = (stepId: string, attempt = 1): Event => ({
  type: 'step.started',
  batchId: 'b1',
  stepId,
  attempt,
});
const finished = (stepId: string, outcome: StepOutcome, attempt = 1): Event => ({
  type: 'step.finished',
  batchId: 'b1',
  stepId,
  attempt,
  outcome,
});
const succeeded = { kind: 'succeeded', output: { verdict: 'approve' } } as const;
const changes = 'the Taster asks for changes: a missing deadline';
const blockedOutcome = {
  kind: 'failed',
  retryable: false,
  reason: `blocked (findings): ${changes}`,
} as const;
const finish = (stepId: string, ending: Extract<Command, { kind: 'finish' }>['ending']) =>
  ({ kind: 'finish', batchId: 'b1', stepId, attempt: 1, ending }) as const;
const blocked = { kind: 'blocked', blockerKind: 'findings', summary: changes } as const;

/** Batch b1 with implement done, and both children of the tasting group started. */
const inGroup: Event[] = [
  { type: 'batch.ordered', batchId: 'b1', order: { issue: 100 }, routeBy: inAnHour },
  {
    type: 'batch.recipe_chosen',
    batchId: 'b1',
    recipe: 'flight',
    reason: 'lens label',
    source: 'label',
  },
  scheduled('implement'),
  started('implement'),
  finished('implement', { kind: 'succeeded', output: null }),
  scheduled('correctness'),
  scheduled('security'),
  started('correctness'),
  started('security'),
];

const accepts = (events: Event[], command: Command, expected: Event[]): void => {
  assert.deepStrictEqual(decide(fold(events), command, context), {
    kind: 'accepted',
    events: expected,
  });
};

const stuckOn = (reason: StuckReason, options: StuckOption[]) =>
  ({
    type: 'batch.stuck',
    batchId: 'b1',
    reason,
    options,
    remindAt: '2026-10-17T12:00:00.000Z',
  }) as const;

describe('a parallel group (ADR 0168)', () => {
  it('schedules every child at once when the batch enters the group', () => {
    const before = inGroup.slice(0, 4);
    accepts(before, finish('implement', { kind: 'succeeded', output: null }), [
      finished('implement', { kind: 'succeeded', output: null }),
      next('correctness'),
      next('security'),
    ]);
  });

  it('waits for the other children when one succeeds', () => {
    accepts(inGroup, finish('correctness', succeeded), [finished('correctness', succeeded)]);
  });

  it('goes on to the step after the group once every child succeeded', () => {
    accepts([...inGroup, finished('security', succeeded)], finish('correctness', succeeded), [
      finished('correctness', succeeded),
      next('polish'),
    ]);
  });

  it('waits for the other children when a blocking child asks for changes', () => {
    accepts(inGroup, finish('correctness', blocked), [finished('correctness', blockedOutcome)]);
  });

  it("sends the batch back along a blocking child's route once the group ended", () => {
    accepts([...inGroup, finished('correctness', blockedOutcome)], finish('security', succeeded), [
      finished('security', succeeded),
      { ...next('implement', 2), route: { from: 'correctness', why: 'findings' } },
    ]);
  });

  it('makes the batch Stuck at once when a child is blocked by findings with no route', () => {
    accepts(inGroup, finish('security', blocked), [
      finished('security', blockedOutcome),
      stuckOn({ kind: 'blocked', stepId: 'security', blockerKind: 'findings', summary: changes }, [
        'retry',
        'skip',
        'recipe',
        'rewind',
        'cancel',
      ]),
    ]);
  });

  it('retries a failed child alone, leaving its sibling running', () => {
    const failed = { kind: 'failed', retryable: true, reason: 'out doc missing' } as const;
    accepts(inGroup, finish('security', failed), [
      finished('security', failed),
      { ...next('security', 2), retry: true },
    ]);
  });

  describe('after a child made the batch Stuck', () => {
    const question = {
      q: 'Is the cache shared?',
      options: ['yes', 'no'],
      recommended: 'yes',
      whyBlocking: 'scope',
    };
    const reason: StuckReason = {
      kind: 'needs_input',
      stepId: 'correctness',
      questions: [question],
    };
    const all = ['answer', 'retry', 'skip', 'recipe', 'rewind', 'cancel'] as const;
    const asked = finished('correctness', { kind: 'needs_input', questions: [question] });
    // security was still running, so Stuck abandoned it.
    const stuck = [...inGroup, asked, stuckOn(reason, [...all])];
    const resumed = (action: string): Event =>
      ({ type: 'batch.resumed', batchId: 'b1', ...by, action }) as Event;

    it('a retry schedules the child and every sibling that had not ended', () => {
      accepts(stuck, { kind: 'retry', batchId: 'b1', ...by }, [
        resumed('retry'),
        { ...next('correctness', 2), retry: true },
        next('security', 2),
      ]);
    });

    it('a retry leaves a sibling that had ended as it was', () => {
      const ended = [...inGroup, finished('security', succeeded), asked, stuckOn(reason, [...all])];
      accepts(ended, { kind: 'retry', batchId: 'b1', ...by }, [
        resumed('retry'),
        { ...next('correctness', 2), retry: true },
      ]);
    });

    it('an answer schedules the child and every sibling that had not ended', () => {
      const answers = [{ q: question.q, answer: 'yes' }];
      accepts(stuck, { kind: 'answer', batchId: 'b1', ...by, answers }, [
        { type: 'input.received', batchId: 'b1', stepId: 'correctness', ...by, answers },
        resumed('answer'),
        { ...next('correctness', 2), answered: true },
        next('security', 2),
      ]);
    });

    it('a skip skips the rest of the group', () => {
      accepts(stuck, { kind: 'skip', batchId: 'b1', ...by }, [resumed('skip'), next('polish')]);
    });

    it('a rewind to a child runs the whole group again', () => {
      const shas = { 'acme/api': 'a'.repeat(40) };
      const ended = [...inGroup, finished('security', succeeded), asked, stuckOn(reason, [...all])];
      accepts(ended, { kind: 'rewind', batchId: 'b1', ...by, toStepId: 'correctness', shas }, [
        { type: 'batch.rewound', batchId: 'b1', toStepId: 'correctness', ...by, shas },
        next('correctness', 2),
        next('security', 2),
      ]);
    });
  });

  it('refuses a rewind to the group itself, which no attempt runs', () => {
    const question = { q: 'Is it shared?', options: ['yes'], recommended: 'yes', whyBlocking: 'x' };
    const reason: StuckReason = {
      kind: 'needs_input',
      stepId: 'correctness',
      questions: [question],
    };
    const all = ['answer', 'retry', 'skip', 'recipe', 'rewind', 'cancel'] as const;
    const asked = finished('correctness', { kind: 'needs_input', questions: [question] });
    const stuck = [...inGroup, asked, stuckOn(reason, [...all])];
    const shas = { 'acme/api': 'a'.repeat(40) };
    assert.deepStrictEqual(
      decide(
        fold(stuck),
        { kind: 'rewind', batchId: 'b1', ...by, toStepId: 'tasting', shas },
        context,
      ),
      {
        kind: 'refused',
        reason:
          'step tasting is a parallel group: rewind to one of its children, which runs the whole group again (ADR 0168)',
      },
    );
  });

  it('goes back along the first blocking child in the recipe, whichever ended first', () => {
    const both: Context = {
      ...context,
      recipes: fakeRecipes({
        flight: fakeRecipe({
          steps: ['implement', 'tasting', 'polish'],
          groups: { tasting: ['correctness', 'security'] },
          routes: { correctness: { findings: 'implement' }, security: { findings: 'implement' } },
        }),
      }),
    };
    const back = { ...next('implement', 2), route: { from: 'correctness', why: 'findings' } };
    for (const [first, last] of [
      ['correctness', 'security'],
      ['security', 'correctness'],
    ] as const) {
      const events = [...inGroup, finished(first, blockedOutcome)];
      assert.deepStrictEqual(decide(fold(events), finish(last, blocked), both), {
        kind: 'accepted',
        events: [finished(last, blockedOutcome), back],
      });
    }
  });

  it('makes the batch Stuck on a divergence when the group gained a child the batch never scheduled', () => {
    // The recipe file changed under the batch: style joined the group after it was entered.
    const grown: Context = {
      ...context,
      recipes: fakeRecipes({
        flight: fakeRecipe({
          steps: ['implement', 'tasting', 'polish'],
          groups: { tasting: ['correctness', 'security', 'style'] },
        }),
      }),
    };
    const summary =
      'the parallel group tasting of recipe flight has a child style the batch never scheduled: its file changed under the batch';
    assert.deepStrictEqual(
      decide(
        fold([...inGroup, finished('security', succeeded)]),
        finish('correctness', succeeded),
        grown,
      ),
      {
        kind: 'accepted',
        events: [
          finished('correctness', succeeded),
          stuckOn({ kind: 'blocked', stepId: 'style', blockerKind: 'divergence', summary }, [
            'retry',
            'skip',
            'recipe',
            'rewind',
            'cancel',
          ]),
        ],
      },
    );
  });

  it('waits for the children still in flight before it is Stuck on a child it gained', () => {
    const grown: Context = {
      ...context,
      recipes: fakeRecipes({
        flight: fakeRecipe({
          steps: ['implement', 'tasting', 'polish'],
          groups: { tasting: ['correctness', 'security', 'style'] },
        }),
      }),
    };
    assert.deepStrictEqual(decide(fold(inGroup), finish('correctness', succeeded), grown), {
      kind: 'accepted',
      events: [finished('correctness', succeeded)],
    });
  });

  it('does not leave the group while a child the recipe dropped still runs', () => {
    // The recipe file changed under the batch: security left the group while its attempt ran.
    const shrunk: Context = {
      ...context,
      recipes: fakeRecipes({
        flight: fakeRecipe({
          steps: ['implement', 'tasting', 'polish'],
          groups: { tasting: ['correctness'] },
        }),
      }),
    };
    assert.deepStrictEqual(decide(fold(inGroup), finish('correctness', succeeded), shrunk), {
      kind: 'accepted',
      events: [finished('correctness', succeeded)],
    });
  });
});
