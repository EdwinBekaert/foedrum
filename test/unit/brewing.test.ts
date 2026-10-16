// End to end through the engine (#11): decide, the supervisor and the fake brewer runner against an
// in-memory event store, with a clock the test moves. Each runner behaviour ends in its lane.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptLimits } from '../../src/engine/brewer-runner.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Stall } from '../../src/engine/recipes.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { createBrewing, defaultLimits } from '../helpers/brewing.ts';
import {
  type Behaviour,
  behave,
  fakeBrewerRunner,
  question,
} from '../helpers/fake-brewer-runner.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const t0 = new Date('2026-10-15T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const iso = (minutes: number): string => at(minutes).toISOString();
const pullRequest = 'https://github.com/acme/api/pull/7';

/** The batch's history in short: what each event did. */
const trail = (events: readonly Event[]): string[] =>
  events.map((event) => {
    switch (event.type) {
      case 'step.scheduled':
      case 'step.started':
        return `${event.type.slice(5)} ${event.stepId}#${event.attempt}`;
      case 'step.finished':
        return `finished ${event.stepId}#${event.attempt} ${event.outcome.kind}`;
      case 'batch.stuck':
        return `stuck ${event.reason.kind}`;
      case 'batch.resumed':
        return `resumed ${event.action}`;
      default:
        return event.type;
    }
  });

const finished = (events: readonly Event[]) =>
  events.flatMap((event) => (event.type === 'step.finished' ? [event] : []));

describe('brewing with the fake brewer runner', () => {
  let store: EventStore;
  let now: Date;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    now = t0;
  });
  afterEach(() => store.close());

  /** Orders batch b1 and routes it to a two-step recipe whose attempts play `scripts`. */
  const brew = async (
    scripts: Record<string, readonly Behaviour[]>,
    options: { stall?: Stall; limits?: Partial<AttemptLimits> } = {},
  ) => {
    const stall = options.stall === undefined ? {} : { stall: options.stall };
    const runner = fakeBrewerRunner(scripts);
    const recipes = fakeRecipes({
      pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 2, ...stall }),
    });
    const brewing = createBrewing({
      store,
      runner,
      recipes,
      clock: () => now,
      limits: () => ({ ...defaultLimits, ...options.limits }),
    });
    assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
    assert.ok(
      brewing.command({
        kind: 'route',
        batchId: 'b1',
        recipe: 'pint',
        reason: 'feature label',
        source: 'label',
      }),
    );
    await brewing.drive();
    return { brewing, runner, recipes };
  };

  const head = ['batch.ordered', 'batch.recipe_chosen', 'scheduled plan#1', 'started plan#1'];

  it('succeeds: every step runs once and the batch goes on tap, leases released', async () => {
    const { brewing } = await brew({ plan: [behave.succeed()], implement: [behave.succeed()] });
    assert.deepStrictEqual(trail(brewing.events()), [
      ...head,
      'finished plan#1 succeeded',
      'scheduled implement#1',
      'started implement#1',
      'finished implement#1 succeeded',
      'batch.on_tap',
    ]);
    assert.deepStrictEqual(brewing.batch('b1').lane, {
      kind: 'on_tap',
      pullRequests: [pullRequest],
    });
    const [plan] = finished(brewing.events());
    assert.deepStrictEqual(plan?.outcome, {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Done', assumptions: [] },
    });
    assert.deepStrictEqual(store.currentLeases(now), []);
    assert.deepStrictEqual(store.expiredLeases(at(24 * 60)), []);
  });

  describe('fails', () => {
    it('retryably: the step gets another attempt', async () => {
      const { brewing } = await brew({
        plan: [behave.fail(true), behave.succeed()],
        implement: [behave.succeed()],
      });
      assert.deepStrictEqual(trail(brewing.events()).slice(0, 8), [
        ...head,
        'finished plan#1 failed',
        'scheduled plan#2',
        'started plan#2',
        'finished plan#2 succeeded',
      ]);
      assert.deepStrictEqual(finished(brewing.events())[0]?.outcome, {
        kind: 'failed',
        retryable: true,
        reason: 'the brewer failed: The migration does not apply',
      });
      assert.equal(brewing.batch('b1').lane.kind, 'on_tap');
    });

    it('retryably until the attempts are used up: Stuck', async () => {
      const { brewing } = await brew({ plan: [behave.fail(true), behave.fail(true)] });
      assert.deepStrictEqual(brewing.batch('b1').lane, {
        kind: 'stuck',
        reason: {
          kind: 'attempts_exhausted',
          stepId: 'plan',
          attempts: 2,
          lastReason: 'the brewer failed: The migration does not apply',
        },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt: new Date(t0.getTime() + 2 * 24 * 60 * minute).toISOString(),
      });
    });

    it('not retryably: Stuck after one attempt', async () => {
      const { brewing } = await brew({ plan: [behave.fail(false)] });
      assert.deepStrictEqual(trail(brewing.events()), [
        ...head,
        'finished plan#1 failed',
        'stuck attempts_exhausted',
      ]);
      const { lane } = brewing.batch('b1');
      assert.deepStrictEqual(lane.kind === 'stuck' && lane.reason, {
        kind: 'attempts_exhausted',
        stepId: 'plan',
        attempts: 1,
        lastReason: 'the brewer could not start: claude was not found on PATH',
      });
    });
  });

  describe('hangs', () => {
    const progress = { lastProgressAt: t0, turnsWithoutProgress: 3 };

    it('until its deadline: Stuck, and the runner stops the abandoned process', async () => {
      const { brewing, runner } = await brew({ plan: [behave.hang(progress)] });
      now = at(59);
      await brewing.tick();
      assert.equal(brewing.batch('b1').lane.kind, 'brewing');
      assert.deepStrictEqual(runner.stopped, []);

      now = at(60);
      await brewing.tick();
      assert.deepStrictEqual(trail(brewing.events()), [...head, 'stuck deadline_passed']);
      const { lane } = brewing.batch('b1');
      assert.deepStrictEqual(lane.kind === 'stuck' && lane.reason, {
        kind: 'deadline_passed',
        stepId: 'plan',
        deadlineAt: iso(60),
      });
      assert.deepStrictEqual(runner.stopped, [
        attemptKey.encode({ batchId: 'b1', stepId: 'plan', attempt: 1 }),
      ]);
      // The stopped attempt ends as cancelled, too late: Stuck abandoned it (ADR 0025).
      assert.deepStrictEqual(brewing.refusals, ['batch b1 is stuck; finish needs it brewing']);
    });

    it('without progress for the stall limit: Stuck as stalled', async () => {
      const { brewing, runner } = await brew(
        { plan: [behave.hang(progress)] },
        { stall: { minutes: 20 } },
      );
      now = at(19);
      await brewing.tick();
      assert.equal(brewing.batch('b1').lane.kind, 'brewing');

      now = at(20);
      await brewing.tick();
      assert.deepStrictEqual(trail(brewing.events()), [...head, 'stuck stalled']);
      const { lane } = brewing.batch('b1');
      assert.deepStrictEqual(lane.kind === 'stuck' && lane.reason, {
        kind: 'stalled',
        stepId: 'plan',
        lastProgressAt: iso(0),
        turnsWithoutProgress: 3,
      });
      assert.equal(runner.stopped.length, 1);
    });

    it('until its deadline, then a retry: only the new attempt holds a lease (I2)', async () => {
      const { brewing } = await brew({ plan: [behave.hang(progress), behave.hang(progress)] });
      now = at(60);
      await brewing.tick();
      assert.ok(brewing.command({ kind: 'retry', batchId: 'b1', by: 'octocat', via: 'terminal' }));
      await brewing.drive();
      // The stopped attempt's finish was refused, and its lease went with it.
      assert.deepStrictEqual(
        store.currentLeases(now).map((lease) => lease.attemptKey),
        [attemptKey.encode({ batchId: 'b1', stepId: 'plan', attempt: 2 })],
      );
    });
  });

  describe('crashes mid-step', () => {
    it('when the brewer process dies: a retryable failure, and the next attempt runs', async () => {
      const { brewing } = await brew({
        plan: [behave.crash(), behave.succeed()],
        implement: [behave.succeed()],
      });
      assert.deepStrictEqual(finished(brewing.events())[0]?.outcome, {
        kind: 'failed',
        retryable: true,
        reason: 'the brewer process was killed by SIGSEGV',
      });
      assert.equal(brewing.batch('b1').lane.kind, 'on_tap');
    });

    it('when the runner dies with it: the lease expires, the attempt is lost and retried', async () => {
      const { brewing } = await brew({
        plan: [behave.lost(), behave.succeed()],
        implement: [behave.succeed()],
      });
      now = at(4);
      await brewing.tick();
      assert.equal(brewing.batch('b1').lane.kind, 'brewing');

      now = at(5);
      await brewing.tick();
      assert.deepStrictEqual(finished(brewing.events())[0]?.outcome, {
        kind: 'failed',
        retryable: true,
        reason: `the attempt was lost: the lease of driver-1 expired at ${iso(5)}`,
      });
      assert.deepStrictEqual(trail(brewing.events()).slice(4, 8), [
        'finished plan#1 failed',
        'scheduled plan#2',
        'started plan#2',
        'finished plan#2 succeeded',
      ]);
      assert.equal(brewing.batch('b1').lane.kind, 'on_tap');
    });
  });

  describe('the driver dies and starts again on the same store', () => {
    it('expires the leases of its earlier run at once', async () => {
      const progress = { lastProgressAt: t0, turnsWithoutProgress: 3 };
      const { recipes } = await brew({ plan: [behave.hang(progress)] });
      now = at(2);
      const restarted = createBrewing({
        store,
        runner: fakeBrewerRunner({ plan: [behave.succeed()], implement: [behave.succeed()] }),
        recipes,
        clock: () => now,
      });
      restarted.start();
      assert.deepStrictEqual(store.currentLeases(now), []);
      assert.deepStrictEqual(
        store.expiredLeases(now).map((lease) => [lease.attemptKey, lease.expiresAt]),
        [[attemptKey.encode({ batchId: 'b1', stepId: 'plan', attempt: 1 }), now]],
      );
    });

    it('loses the attempts its earlier run held at the next tick, and retries them', async () => {
      const { recipes } = await brew({ plan: [behave.lost()] });
      now = at(1);
      const restarted = createBrewing({
        store,
        runner: fakeBrewerRunner({ plan: [behave.succeed()], implement: [behave.succeed()] }),
        recipes,
        clock: () => now,
      });
      restarted.start();
      await restarted.tick();
      assert.deepStrictEqual(finished(restarted.events())[0]?.outcome, {
        kind: 'failed',
        retryable: true,
        reason: `the attempt was lost: the lease of driver-1 expired at ${iso(1)}`,
      });
      assert.equal(restarted.batch('b1').lane.kind, 'on_tap');
    });
  });

  it('writes garbage to its stream: a retryable failure, whatever the out doc says', async () => {
    const { brewing } = await brew({ plan: [behave.garbage(), behave.garbage()] });
    const [first] = finished(brewing.events());
    assert.equal(first?.outcome.kind === 'failed' && first.outcome.retryable, true);
    assert.match(
      first?.outcome.kind === 'failed' ? first.outcome.reason : '',
      /^the event stream is not stream-json: .*Abort trap/,
    );
    assert.equal(brewing.batch('b1').lane.kind, 'stuck');
  });

  describe('out doc', () => {
    it('missing: a retryable failure, never success', async () => {
      const { brewing } = await brew({
        plan: [behave.missingOutDoc(), behave.succeed()],
        implement: [behave.succeed()],
      });
      assert.deepStrictEqual(finished(brewing.events())[0]?.outcome, {
        kind: 'failed',
        retryable: true,
        reason: 'the out doc out.md is missing',
      });
      assert.equal(brewing.batch('b1').lane.kind, 'on_tap');
    });

    it('invalid: a retryable failure with the reason', async () => {
      const { brewing } = await brew({ plan: [behave.invalidOutDoc(), behave.invalidOutDoc()] });
      const [first] = finished(brewing.events());
      assert.match(
        first?.outcome.kind === 'failed' ? first.outcome.reason : '',
        /^the out doc out\.md is invalid: .*status/s,
      );
      assert.equal(brewing.batch('b1').lane.kind, 'stuck');
    });
  });

  it('exceeds its budget: Stuck after one attempt', async () => {
    const { brewing } = await brew(
      { plan: [behave.exceedBudget(121)] },
      { limits: { maxTurns: 120 } },
    );
    assert.deepStrictEqual(trail(brewing.events()), [
      ...head,
      'finished plan#1 failed',
      'stuck attempts_exhausted',
    ]);
    const { lane } = brewing.batch('b1');
    assert.deepStrictEqual(lane.kind === 'stuck' && lane.reason, {
      kind: 'attempts_exhausted',
      stepId: 'plan',
      attempts: 1,
      lastReason: 'budget exceeded: 121 turns, maxTurns is 120',
    });
  });

  it('needs input: Stuck with the questions, and the answer resumes the step', async () => {
    const { brewing } = await brew({
      plan: [behave.needInput(), behave.succeed()],
      implement: [behave.succeed()],
    });
    assert.deepStrictEqual(trail(brewing.events()), [
      ...head,
      'finished plan#1 needs_input',
      'stuck needs_input',
    ]);
    const { lane } = brewing.batch('b1');
    assert.deepStrictEqual(lane.kind === 'stuck' && [lane.reason, lane.options], [
      { kind: 'needs_input', stepId: 'plan', questions: [question] },
      ['answer', 'retry', 'skip', 'recipe', 'rewind', 'cancel'],
    ]);

    assert.ok(
      brewing.command({
        kind: 'answer',
        batchId: 'b1',
        by: 'octocat',
        via: 'plugin',
        answers: [{ q: question.q, answer: 'sqlite' }],
      }),
    );
    await brewing.drive();
    assert.deepStrictEqual(trail(brewing.events()).slice(6, 11), [
      'input.received',
      'resumed answer',
      'scheduled plan#2',
      'started plan#2',
      'finished plan#2 succeeded',
    ]);
    assert.equal(brewing.batch('b1').lane.kind, 'on_tap');
  });

  it('meets a storm of permission denials: Stuck at once, naming the denied tools', async () => {
    const npmTest = 'Bash(npm test)';
    const { brewing } = await brew(
      { plan: [behave.denialStorm([npmTest, 'WebFetch', npmTest, npmTest, 'WebFetch'])] },
      { limits: { maxDenials: 5 } },
    );
    assert.deepStrictEqual(trail(brewing.events()), [
      ...head,
      'finished plan#1 failed',
      'stuck blocked',
    ]);
    const summary = '5 permission denials, maxDenials is 5; denied: Bash(npm test), WebFetch';
    assert.deepStrictEqual(finished(brewing.events())[0]?.outcome, {
      kind: 'failed',
      retryable: false,
      reason: `blocked (environment): ${summary}`,
    });
    const { lane } = brewing.batch('b1');
    assert.deepStrictEqual(lane.kind === 'stuck' && lane.reason, {
      kind: 'blocked',
      stepId: 'plan',
      blockerKind: 'environment',
      summary,
    });
  });
});
