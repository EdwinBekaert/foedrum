// The command layer's one way to append: decided against every committed event, in the transaction
// that appends (ADR 0019, ADR 0025). Two logs on one store stand for two writers, such as a driver
// and a terminal command.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const t0 = new Date('2026-10-15T12:00:00.000Z');
const iso = (minutes: number): string => new Date(t0.getTime() + minutes * 60_000).toISOString();
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'] }) });

const stuck: Event[] = [
  { type: 'batch.ordered', batchId: 'b1', order: { issue: 1 }, routeBy: iso(60) },
  { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'pint', reason: 'label', source: 'label' },
  { type: 'step.scheduled', batchId: 'b1', stepId: 'plan', attempt: 1, deadlineAt: iso(60) },
  { type: 'step.started', batchId: 'b1', stepId: 'plan', attempt: 1 },
  {
    type: 'batch.stuck',
    batchId: 'b1',
    reason: { kind: 'waiting_for_session', stepId: 'plan' },
    options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
    remindAt: iso(120),
  },
];
const retry = { kind: 'retry', batchId: 'b1', by: 'ada', via: 'terminal' } as const;
const key = attemptKey.encode({ batchId: 'b1', stepId: 'plan', attempt: 2 });

describe('createCommandLog', () => {
  let store: EventStore;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    store.withTransaction((tx) => {
      for (const event of stuck) tx.append(event);
    });
  });
  afterEach(() => store.close());

  const log = () => createCommandLog({ store, recipes });
  const types = () => store.eventsAfter(0).map(({ event }) => event.type);

  it('appends the events of an accepted command, and its state folds them', () => {
    const terminal = log();
    const decision = terminal.issue(retry, t0);
    assert.equal(decision.kind, 'accepted');
    assert.deepStrictEqual(types().slice(stuck.length), ['batch.resumed', 'step.scheduled']);
    assert.equal(terminal.state().batches.get('b1')?.lane.kind, 'brewing');
  });

  it('schedules with the reminder and routing intervals it is given', () => {
    const reminded = createCommandLog({ store, recipes, reminderMs: 60_000 });
    reminded.issue({ kind: 'remind', batchId: 'b1' }, new Date(iso(120)));
    const lane = reminded.state().batches.get('b1')?.lane;
    assert.equal(lane?.kind === 'stuck' && lane.remindAt, iso(121));
    const ordered = createCommandLog({ store, recipes, routingMs: 5 * 60_000 });
    ordered.issue({ kind: 'order', batchId: 'b2', order: { issue: 2 } }, t0);
    assert.deepStrictEqual(store.eventsAfter(0).at(-1)?.event, {
      type: 'batch.ordered',
      batchId: 'b2',
      order: { issue: 2 },
      routeBy: iso(5),
    });
  });

  it('decides against the events another writer appended since it last read the store', () => {
    const driver = log();
    const terminal = log();
    assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
    assert.equal(terminal.issue(retry, t0).kind, 'accepted');
    // The driver's last read still shows b1 Stuck; a second retry would schedule plan#2 twice.
    const decision = driver.issue(retry, t0);
    assert.deepStrictEqual(decision, {
      kind: 'refused',
      reason: 'batch b1 is brewing; retry needs it stuck',
    });
    assert.equal(types().length, stuck.length + 2);
    assert.equal(driver.state().batches.get('b1')?.lane.kind, 'brewing');
  });

  it('decides against an event another writer commits just before its transaction starts', () => {
    // The other writer's commit lands after the log last read the store, as the write
    // transaction is about to begin.
    let raced = false;
    const racing: EventStore = {
      ...store,
      withTransaction: (fn) => {
        if (!raced) {
          raced = true;
          store.withTransaction((tx) =>
            tx.append({ type: 'batch.cancelled', batchId: 'b1', by: 'bob', via: 'comment' }),
          );
        }
        return store.withTransaction(fn);
      },
    };
    const driver = createCommandLog({ store: racing, recipes });
    assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
    assert.deepStrictEqual(driver.issue(retry, t0), {
      kind: 'refused',
      reason: 'batch b1 is cancelled; retry needs it stuck',
    });
    assert.equal(types().at(-1), 'batch.cancelled');
  });

  it('commits the extra writes with the events', () => {
    log().issue(retry, t0, (tx) =>
      tx.putLease({ attemptKey: key, owner: 'cellar', expiresAt: new Date(iso(5)) }),
    );
    assert.deepStrictEqual(
      store.currentLeases(t0).map((lease) => lease.attemptKey),
      [key],
    );
  });

  it('appends nothing and runs no extra writes for a refused command', () => {
    let ran = false;
    const decision = log().issue(
      { kind: 'skip', batchId: 'b9', by: 'ada', via: 'terminal' },
      t0,
      () => {
        ran = true;
      },
    );
    assert.deepStrictEqual(decision, { kind: 'refused', reason: 'batch b9 was never ordered' });
    assert.equal(ran, false);
    assert.equal(types().length, stuck.length);
  });

  it('rolls the events back when the extra writes throw', () => {
    const terminal = log();
    assert.throws(
      () =>
        terminal.issue(retry, t0, () => {
          throw new Error('the disk is full');
        }),
      /the disk is full/,
    );
    assert.equal(types().length, stuck.length);
    assert.equal(terminal.state().batches.get('b1')?.lane.kind, 'stuck');
  });
});
