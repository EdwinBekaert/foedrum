// An issue edited or commented on after its approving label asks the engineer whether to continue
// (ADR 0368): the driver reads what changed on a claimed order's issue before each brewer attempt
// starts, and a change since the label, or since the engineer's latest "continue", parks the batch
// Stuck with one question, answered with `foedrum answer`. An in-memory store, a runner the test
// ends by hand, and a fake issue history; no GitHub.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { markedComment } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import {
  createOrderCheck,
  ORDER_CHANGED_QUESTION,
  type OrderActivity,
} from '../../src/engine/order-changes.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const t0 = new Date('2026-11-10T12:00:00.000Z');
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'] }) });
const users = ['maintainer'];
const login = 'maintainer';
const filter = { labels: ['foedrum:brew'] };
const batchId = 'app-7';
const labelled = '2026-11-10T10:00:00Z';
const before = '2026-11-10T09:00:00Z';
const after = '2026-11-10T11:00:00Z';
const later = '2026-11-10T13:00:00Z';
const by = { by: 'maintainer', via: 'terminal' } as const;

/** An issue a maintainer labelled at `labelled`, opened before it by a stranger. */
const approved = (): OrderActivity => ({
  labelled: [{ label: 'foedrum:brew', by: 'maintainer', at: labelled }],
  renamed: [],
  edited: [{ by: 'stranger', at: before }],
  comments: [
    {
      id: 1,
      by: 'stranger',
      association: 'NONE',
      created: before,
      updated: before,
      body: 'Me too.',
    },
  ],
});

/** A runner whose attempts run until the test ends them. */
const handRunner = () => {
  const running = new Map<string, (end: AttemptEnd) => void>();
  const started: AttemptRef[] = [];
  const runner: BrewerRunner = {
    start: ({ ref }) => {
      started.push(ref);
      const ended = new Promise<AttemptEnd>((resolve) => {
        running.set(attemptKey.encode(ref), resolve);
      });
      return { ended, stop: () => {} };
    },
    progress: (ref) =>
      running.has(attemptKey.encode(ref))
        ? { lastProgressAt: t0, turnsWithoutProgress: 0 }
        : undefined,
  };
  const end = (ref: AttemptRef): void => {
    const resolve = running.get(attemptKey.encode(ref));
    assert.ok(resolve, `${attemptKey.encode(ref)} runs`);
    running.delete(attemptKey.encode(ref));
    resolve({
      ending: { kind: 'succeeded', output: { status: 'done', summary: 'Done', assumptions: [] } },
    });
  };
  return { runner, started, end };
};

describe('an order whose issue changed after its approval (ADR 0368)', () => {
  let store: EventStore;
  let log: CommandLog;
  let activity: OrderActivity;
  let reads: string[];
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    activity = approved();
    reads = [];
    // The intake's claim of acme/app#7, routed to pint: plan#1 is scheduled.
    const order = { kind: 'order', batchId, order: { issue: 7, repo: 'acme/app' } } as const;
    assert.equal(log.issue(order, t0).kind, 'accepted');
    const route = {
      kind: 'route',
      batchId,
      recipe: 'pint',
      reason: 'label',
      source: 'label',
    } as const;
    assert.equal(log.issue(route, t0).kind, 'accepted');
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const open = async (runner: BrewerRunner) => {
    const orderCheck = createOrderCheck({
      activity: async (repo, issue) => {
        reads.push(`${repo}#${issue}`);
        return activity;
      },
      users,
      login,
      filterOf: (repo) => (repo === 'acme/app' ? filter : undefined),
    });
    const driver = await openDriver({
      store,
      runner,
      recipes,
      clock: () => t0,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      orderCheck,
    });
    drivers.push(driver);
    return driver;
  };
  const lane = (driver: Driver) => driver.state().batches.get(batchId)?.lane;
  const startedTypes = () =>
    store
      .eventsAfter(0)
      .map(({ event }) => event.type)
      .filter((type) => type === 'step.started');
  const answer = (reply: string) =>
    log.issue(
      {
        kind: 'answer',
        batchId,
        ...by,
        answers: [{ q: ORDER_CHANGED_QUESTION, answer: reply }],
      },
      t0,
    ).kind;

  it('an issue whose body was edited after its label asks the engineer before the attempt reads it', async () => {
    activity = {
      ...approved(),
      edited: [
        { by: 'stranger', at: before },
        { by: 'stranger', at: after },
      ],
    };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    assert.deepStrictEqual(startedTypes(), []);
    assert.deepStrictEqual(reads, ['acme/app#7']);
    assert.deepStrictEqual(lane(driver), {
      kind: 'stuck',
      reason: {
        kind: 'order_changed',
        stepId: 'plan',
        changes: [{ what: 'body', by: 'stranger', at: after }],
        more: 0,
        upTo: after,
      },
      options: ['answer', 'cancel'],
      remindAt: '2026-11-12T12:00:00.000Z',
    });
  });

  it('an issue whose title was edited after its label asks the engineer', async () => {
    activity = { ...approved(), renamed: [{ by: 'stranger', at: after }] };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const found = lane(driver);
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.deepStrictEqual(found.reason.changes, [{ what: 'title', by: 'stranger', at: after }]);
  });

  it('a comment added after the label asks the engineer', async () => {
    activity = {
      ...approved(),
      comments: [
        ...approved().comments,
        {
          id: 2,
          by: 'collaborator',
          association: 'COLLABORATOR',
          created: after,
          updated: after,
          body: 'Also drop the old API.',
        },
      ],
    };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const found = lane(driver);
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.deepStrictEqual(found.reason.changes, [
      { what: 'comment', comment: 2, by: 'collaborator', at: after },
    ]);
  });

  it('an issue unchanged since its label goes on without a question', async () => {
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, [{ batchId, stepId: 'plan', attempt: 1 }]);
    assert.equal(lane(driver)?.kind, 'brewing');
    assert.deepStrictEqual(reads, ['acme/app#7']);
  });

  it("Foedrum's own comment after the label asks nothing", async () => {
    activity = {
      ...approved(),
      comments: [
        {
          id: 3,
          by: login,
          association: 'OWNER',
          created: after,
          updated: after,
          body: markedComment('Claimed by acme/brewery.', 'claim:app-7'),
        },
      ],
    };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, [{ batchId, stepId: 'plan', attempt: 1 }]);
    assert.equal(lane(driver)?.kind, 'brewing');
  });

  it('continue approves the issue as it is, and a later edit asks again', async () => {
    activity = { ...approved(), edited: [{ by: 'stranger', at: after }] };
    const { runner, started, end } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.equal(answer('continue'), 'accepted');
    const types = store.eventsAfter(0).map(({ event }) => event);
    const approval = types.find((event) => event.type === 'order.approved');
    assert.deepStrictEqual(approval, { type: 'order.approved', batchId, upTo: after, ...by });
    await driver.tick();
    assert.equal(started.length, 1);
    const [first] = started;
    assert.ok(first !== undefined && first.stepId === 'plan');
    // What it was shown stays approved; an edit after it asks again before the next attempt.
    activity = { ...activity, edited: [...activity.edited, { by: 'stranger', at: later }] };
    end(first);
    await driver.tick();
    await driver.tick();
    assert.equal(started.length, 1);
    const found = lane(driver);
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.equal(found.reason.stepId, 'implement');
    assert.deepStrictEqual(found.reason.changes, [{ what: 'body', by: 'stranger', at: later }]);
    assert.equal(found.reason.upTo, later);
  });

  it('stop ends the batch as a cancel does', async () => {
    activity = { ...approved(), edited: [{ by: 'stranger', at: after }] };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.equal(answer('stop'), 'accepted');
    assert.equal(lane(driver)?.kind, 'cancelled');
    const cancelled = store
      .eventsAfter(0)
      .map(({ event }) => event)
      .filter((event) => event.type === 'batch.cancelled');
    assert.deepStrictEqual(cancelled, [{ type: 'batch.cancelled', batchId, ...by }]);
    await driver.tick();
    assert.deepStrictEqual(started, []);
  });

  it('an edit by someone in users after the label asks too', async () => {
    activity = { ...approved(), edited: [{ by: 'maintainer', at: after }] };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const found = lane(driver);
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.deepStrictEqual(found.reason.changes, [{ what: 'body', by: 'maintainer', at: after }]);
  });

  it('a label a stranger adds again later moves the approval nowhere', async () => {
    const between = '2026-11-10T10:30:00Z';
    activity = {
      ...approved(),
      labelled: [...approved().labelled, { label: 'foedrum:brew', by: 'stranger', at: after }],
      edited: [{ by: 'stranger', at: between }],
    };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const found = lane(driver);
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.deepStrictEqual(found.reason.changes, [{ what: 'body', by: 'stranger', at: between }]);
  });

  it('a label someone in users adds after the order approves nothing the order did not see', async () => {
    activity = {
      ...approved(),
      labelled: [...approved().labelled, { label: 'foedrum:brew', by: 'maintainer', at: later }],
      edited: [{ by: 'stranger', at: after }],
    };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const found = lane(driver);
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.deepStrictEqual(found.reason.changes, [{ what: 'body', by: 'stranger', at: after }]);
  });

  it('an issue nobody in users labelled asks about every change it had', async () => {
    activity = { ...approved(), labelled: [] };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const found = lane(driver);
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.deepStrictEqual(found.reason.changes, [
      { what: 'body', by: 'stranger', at: before },
      { what: 'comment', comment: 1, by: 'stranger', at: before },
    ]);
  });

  it("a person's order approves the issue as it was when they ordered it", async () => {
    // Ordered again by a person at t0, after the stranger's edit and before the next one.
    log.issue({ kind: 'cancel', batchId, ...by }, t0);
    const again = {
      kind: 'order_again',
      batchId: 'app-7-2',
      order: { issue: 7, repo: 'acme/app' },
    };
    assert.equal(log.issue({ ...again, kind: 'order_again', ...by }, t0).kind, 'accepted');
    const route = { kind: 'route', batchId: 'app-7-2', recipe: 'pint', reason: 'label' } as const;
    assert.equal(log.issue({ ...route, source: 'label' }, t0).kind, 'accepted');
    activity = { ...approved(), labelled: [], edited: [{ by: 'stranger', at: after }] };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, [{ batchId: 'app-7-2', stepId: 'plan', attempt: 1 }]);
  });

  it("an edit after a person's order asks", async () => {
    log.issue({ kind: 'cancel', batchId, ...by }, t0);
    const again = {
      kind: 'order_again',
      batchId: 'app-7-2',
      order: { issue: 7, repo: 'acme/app' },
    };
    assert.equal(log.issue({ ...again, kind: 'order_again', ...by }, t0).kind, 'accepted');
    const route = { kind: 'route', batchId: 'app-7-2', recipe: 'pint', reason: 'label' } as const;
    assert.equal(log.issue({ ...route, source: 'label' }, t0).kind, 'accepted');
    activity = { ...approved(), edited: [{ by: 'stranger', at: later }] };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const found = driver.state().batches.get('app-7-2')?.lane;
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.deepStrictEqual(found.reason.changes, [{ what: 'body', by: 'stranger', at: later }]);
  });

  it('a change of a comment made before the label asks, as the comment it now is', async () => {
    activity = {
      ...approved(),
      comments: [
        { ...approved().comments[0], id: 1, updated: after } as OrderActivity['comments'][number],
      ],
    };
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const found = lane(driver);
    assert.ok(found?.kind === 'stuck' && found.reason.kind === 'order_changed');
    assert.deepStrictEqual(found.reason.changes, [
      { what: 'comment', comment: 1, by: 'stranger', at: after },
    ]);
  });

  it('a check that cannot read the issue fails the attempt before it starts', async () => {
    const { runner, started } = handRunner();
    const orderCheck = createOrderCheck({
      activity: async () => {
        throw new Error('GitHub answered 502 to the events of acme/app#7');
      },
      users,
      login,
      filterOf: () => filter,
    });
    const driver = await openDriver({
      store,
      runner,
      recipes,
      clock: () => t0,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      orderCheck,
    });
    drivers.push(driver);
    await driver.tick();
    assert.deepStrictEqual(started, []);
    const attempt = driver.state().batches.get(batchId)?.steps.get('plan')?.attempts.get(1);
    assert.ok(attempt?.phase === 'finished');
    assert.deepStrictEqual(attempt.outcome, {
      kind: 'failed',
      retryable: true,
      reason:
        'the order could not be checked for changes since its approval: GitHub answered 502 to the events of acme/app#7',
    });
  });

  it('a Brewery order is never checked', async () => {
    const order = { kind: 'order', batchId: '12-1', order: { issue: 12 } } as const;
    assert.equal(log.issue(order, t0).kind, 'accepted');
    const route = { kind: 'route', batchId: '12-1', recipe: 'pint', reason: 'label' } as const;
    assert.equal(log.issue({ ...route, source: 'label' }, t0).kind, 'accepted');
    log.issue({ kind: 'cancel', batchId, ...by }, t0);
    const { runner, started } = handRunner();
    const driver = await open(runner);
    await driver.tick();
    assert.deepStrictEqual(started, [{ batchId: '12-1', stepId: 'plan', attempt: 1 }]);
    assert.deepStrictEqual(reads, []);
  });
});
