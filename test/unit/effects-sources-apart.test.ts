// The sources of a driver's effects stay apart (#883, ADR 0335): one that cannot be read leaves the
// others' effects due, and the pass still fails at its end, so nothing reads it as "all done".

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending, RecordedEvent } from '../../src/engine/decide.ts';
import {
  type Driver,
  type DriverEffects,
  type DriverNotice,
  openDriver,
} from '../../src/engine/driver.ts';
import { combineEffects } from '../../src/engine/effects.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const now = new Date('2026-11-06T12:00:00.000Z');
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan'] }) });
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

describe('combineEffects: one source that cannot be read', () => {
  let store: EventStore;
  let log: CommandLog;
  let notices: DriverNotice[];
  let applied: string[];
  let broken: boolean;
  let recordedAsked: number;
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    notices = [];
    applied = [];
    broken = true;
    recordedAsked = 0;
    const batchId = 'b1';
    const accept = (command: Parameters<CommandLog['issue']>[0]): void =>
      assert.equal(log.issue(command, now).kind, 'accepted', JSON.stringify(command));
    accept({ kind: 'order', batchId, order: { issue: 1 } });
    accept({ kind: 'route', batchId, recipe: 'pint', reason: 'label', source: 'label' });
    const ref = { batchId, stepId: 'plan', attempt: 1 };
    accept({ kind: 'record', event: { type: 'step.started', ...ref } });
    accept({ kind: 'finish', ...ref, ending: succeeded });
    assert.equal(log.state().batches.get(batchId)?.lane.kind, 'on_tap');
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const source = (effect: string, more: Partial<DriverEffects> = {}): DriverEffects => ({
    due: (_state, batchId) => [{ batchId, effect }],
    target: {
      find: async () => undefined,
      apply: async (key) => {
        applied.push(effect);
        return { key };
      },
    },
    ...more,
  });
  const merge = (batchId: string): RecordedEvent => ({
    type: 'pull_request.ended',
    batchId,
    pullRequest: 'https://github.com/acme/api/pull/7',
    state: 'merged',
  });
  /** Has a due that throws while `broken`, and records a merge when asked. */
  const unreadable = source('plan', {
    due: (_state, batchId) => {
      if (broken) throw new Error('unreadable plan');
      return [{ batchId, effect: 'plan' }];
    },
    recorded: (state, batchId) => {
      recordedAsked++;
      return state.batches.get(batchId)?.pullRequestEnds === undefined ? [merge(batchId)] : [];
    },
  });
  const open = async (effects: DriverEffects): Promise<Driver> => {
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects,
      report: (notice) => notices.push(notice),
    });
    drivers.push(driver);
    return driver;
  };
  const failures = () => notices.filter(({ kind }) => kind === 'batch_effects_failed');
  const records = () =>
    store.eventsAfter(0).filter(({ event }) => event.type === 'pull_request.ended');

  it("applies the others' effects, whichever side of it they are on", async () => {
    const driver = await open(combineEffects(source('before'), unreadable, source('after')));
    await driver.tick();
    assert.deepStrictEqual(applied, ['before', 'after']);
  });

  it('fails the pass at its end, naming the batch and the error of the source', async () => {
    const driver = await open(combineEffects(unreadable, source('status')));
    await driver.tick();
    const [failure] = failures();
    assert.deepStrictEqual(applied, ['status']);
    assert.equal(failures().length, 1);
    assert.match(
      failure?.kind === 'batch_effects_failed' ? String(failure.error) : '',
      /unreadable plan/,
    );
  });

  it('records nothing the effects call for while a source cannot be read', async () => {
    const driver = await open(combineEffects(unreadable, source('status')));
    await driver.tick();
    assert.deepStrictEqual(applied, ['status']);
    assert.equal(recordedAsked, 0);
    assert.deepStrictEqual(records(), []);
  });

  it('does not let the batch go', async () => {
    const driver = await open(combineEffects(unreadable, source('status')));
    await driver.tick();
    await driver.tick();
    assert.deepStrictEqual(driver.held(), ['b1']);
  });

  it('applies each of the others once over the passes it keeps failing', async () => {
    const driver = await open(combineEffects(unreadable, source('status')));
    await driver.tick();
    await driver.tick();
    assert.deepStrictEqual(applied, ['status']);
  });

  it('once it reads: applies its effects, records what they call for and lets the batch go', async () => {
    const driver = await open(combineEffects(unreadable, source('status')));
    await driver.tick();
    broken = false;
    await driver.tick();
    assert.deepStrictEqual(applied, ['status', 'plan']);
    assert.equal(records().length, 1);
    await driver.tick();
    assert.deepStrictEqual(driver.held(), []);
  });

  it('fails the pass at its end also when another source’s effect failed in it', async () => {
    const refusing = source('status', {
      target: {
        find: async () => undefined,
        apply: async () => {
          throw new Error('host down');
        },
      },
    });
    const driver = await open(combineEffects(unreadable, refusing));
    await driver.tick();
    assert.equal(failures().length, 1);
    assert.equal(notices.filter(({ kind }) => kind === 'effect_failed').length, 1);
  });

  it('goes by its latest read: a source that reads again within the pass fails nothing', async () => {
    const mending = source('status', {
      target: {
        find: async () => undefined,
        apply: async (key) => {
          applied.push('status');
          broken = false;
          return { key };
        },
      },
    });
    const driver = await open(combineEffects(unreadable, mending));
    await driver.tick();
    assert.deepStrictEqual(applied, ['status', 'plan']);
    assert.deepStrictEqual(failures(), []);
    assert.equal(records().length, 1);
  });

  it('applies the others when a source throws what has no readable message', async () => {
    const odd = source('odd', {
      due: () => {
        throw {
          get message(): string {
            throw new Error('no message');
          },
        };
      },
    });
    const driver = await open(combineEffects(odd, source('status')));
    await driver.tick();
    assert.deepStrictEqual(applied, ['status']);
    assert.equal(failures().length, 1);
  });

  it('still throws from a lone source, and records nothing (regression test)', async () => {
    const driver = await open(unreadable);
    await driver.tick();
    assert.equal(failures().length, 1);
    assert.equal(recordedAsked, 0);
  });

  it('every source that cannot be read leaves the pass failing, the first one named', async () => {
    const second = source('other', {
      due: () => {
        throw new Error('second unreadable');
      },
    });
    const driver = await open(combineEffects(unreadable, second, source('status')));
    await driver.tick();
    assert.deepStrictEqual(applied, ['status']);
    const [failure] = failures();
    assert.match(
      failure?.kind === 'batch_effects_failed' ? String(failure.error) : '',
      /unreadable plan/,
    );
  });
});
