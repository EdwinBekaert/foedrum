// The Cellarer's jobs run by the driver (ADR 0380): its shelve forgets every finished batch and
// leaves its folder to the next flush, its sweep clears the Brewery's temporary folder, its expire
// asks the next flush to delete old months of the shelf, and its batch goes on tap with no pull
// request.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ArchiveFacts } from '../../src/engine/archive.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { actionsByKind, cleanupActions, storeFacts } from '../../src/engine/cleanup-actions.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import {
  type Driver,
  type DriverActions,
  type DriverEffects,
  openDriver,
} from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { TEMP_AGE_MS } from '../../src/engine/temp-sweep.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const at = new Date('2026-11-11T12:00:00.000Z');
const who = { by: 'ada', via: 'terminal' } as const;
const recipes = fakeRecipes({
  cleanup: fakeRecipe({
    type: 'tend',
    steps: ['shelve', 'sweep', 'expire'],
    actions: { shelve: 'shelve', sweep: 'sweep', expire: 'expire' },
    pullRequests: [],
  }),
  pint: fakeRecipe({ steps: ['plan'] }),
});

describe('cleanupActions (ADR 0380)', () => {
  let dir: TempDir;
  let temp: string;
  let store: EventStore;
  let log: CommandLog;
  const drivers: Driver[] = [];
  beforeEach(() => {
    dir = makeTempDir('cleanup-actions');
    temp = join(dir.path, '.foedrum', 'tmp');
    mkdirSync(temp, { recursive: true });
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
    dir.remove();
  });

  const issue = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, at);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const order = (batchId: string, recipe: string): void => {
    issue({ kind: 'order', batchId, order: { issue: Number(batchId.split('-')[0]) } });
    issue({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
  };
  const scratch = (name: string, ageMs: number): void => {
    const path = join(temp, name);
    writeFileSync(path, 'scratch\n');
    const when = new Date(at.getTime() - ageMs);
    utimesSync(path, when, when);
  };
  const open = async (actions: DriverActions): Promise<Driver> => {
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no brewer starts'), progress: () => undefined },
      recipes,
      clock: () => at,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      actions,
      report: () => {},
    });
    drivers.push(driver);
    return driver;
  };
  const noFacts = (): ArchiveFacts => ({
    due: () => false,
    leased: new Set(),
    unpushed: () => false,
  });
  const cellarer = (facts: () => ArchiveFacts = noFacts) =>
    cleanupActions({ recipes, log, store, facts, temp, clock: () => at });
  const run = async (driver: Driver): Promise<void> => {
    for (let n = 0; n < 8; n++) await driver.tick();
  };
  const result = (stepId: string) =>
    store.findEffect({ batchId: '9-1', stepId, attempt: 1, effect: stepId })?.result;

  it('the Cellarer shelves every finished batch, sweeps old temporary files and expires old months, and the batch ends on tap', async () => {
    order('1-1', 'pint');
    issue({ kind: 'cancel', batchId: '1-1', ...who });
    issue({ kind: 'order', batchId: '2-1', order: { issue: 2 } });
    order('9-1', 'cleanup');
    scratch('old.txt', TEMP_AGE_MS + 60_000);
    scratch('new.txt', 60_000);

    await run(await open(cellarer()));

    assert.deepStrictEqual([...log.state().batches.keys()], ['2-1', '9-1']);
    assert.equal(store.lastEventOf('1-1'), undefined);
    assert.deepStrictEqual(store.shelving(), [{ batchId: '1-1', month: '2026-11' }]);
    assert.equal(store.expiring(), '2026-05');
    assert.equal(existsSync(join(temp, 'old.txt')), false);
    assert.equal(existsSync(join(temp, 'new.txt')), true);
    assert.deepStrictEqual(log.state().batches.get('9-1')?.lane, {
      kind: 'on_tap',
      pullRequests: [],
    });
    assert.deepStrictEqual(result('shelve'), { cellarer: 'shelve', batches: ['1-1'] });
    assert.deepStrictEqual(result('sweep'), {
      cellarer: 'sweep',
      removed: ['old.txt'],
      failed: [],
    });
    assert.deepStrictEqual(result('expire'), { cellarer: 'expire', before: '2026-05' });
  });

  it('leaves a finished batch the facts say has an effect due', async () => {
    order('1-1', 'pint');
    issue({ kind: 'cancel', batchId: '1-1', ...who });
    order('9-1', 'cleanup');
    const facts = (): ArchiveFacts => ({ ...noFacts(), due: (id) => id === '1-1' });

    await run(await open(cellarer(facts)));

    assert.deepStrictEqual([...log.state().batches.keys()], ['1-1', '9-1']);
    assert.deepStrictEqual(store.shelving(), []);
    assert.equal(log.state().batches.get('9-1')?.lane.kind, 'on_tap');
  });

  it('runs each attempt with the actions of its step, as the recipe names it', async () => {
    order('9-1', 'cleanup');
    const asked: string[] = [];
    const named = (name: string): DriverActions => ({
      due: () => {
        asked.push(name);
        return [];
      },
      target: { find: async () => undefined, apply: async () => null },
      ending: () => ({ kind: 'succeeded', output: {} }),
    });
    const actions = actionsByKind(recipes, {
      openPullRequest: named('openPullRequest'),
      shelve: named('shelve'),
      sweep: named('sweep'),
      expire: named('expire'),
    });

    await run(await open(actions));

    assert.deepStrictEqual([...new Set(asked)], ['shelve', 'sweep', 'expire']);
    assert.equal(log.state().batches.get('9-1')?.lane.kind, 'on_tap');
  });

  it("applies each effect with the actions whose due gave it, a pull request's never asked", async () => {
    order('1-1', 'pint');
    issue({ kind: 'cancel', batchId: '1-1', ...who });
    order('9-1', 'cleanup');
    const refusing: DriverActions = {
      due: () => assert.fail('no pull request step runs'),
      target: { find: () => assert.fail('found'), apply: () => assert.fail('applied') },
      ending: () => assert.fail('ended'),
    };
    const tends = cellarer();
    const actions = actionsByKind(recipes, {
      openPullRequest: refusing,
      shelve: tends,
      sweep: tends,
      expire: tends,
    });

    await run(await open(actions));

    assert.deepStrictEqual(store.shelving(), [{ batchId: '1-1', month: '2026-11' }]);
    assert.equal(log.state().batches.get('9-1')?.lane.kind, 'on_tap');
  });

  it('fails an ending, retryably, whose ledger has no result of its job', () => {
    order('9-1', 'cleanup');
    const ending = cellarer().ending(log.state(), { batchId: '9-1', stepId: 'sweep', attempt: 1 });
    assert.equal(ending.kind === 'failed' && ending.retryable, true);
  });
});

describe('storeFacts (ADR 0380)', () => {
  const at = new Date('2026-11-11T12:00:00.000Z');
  const later = new Date(at.getTime() + 60_000);
  const routeBy = at.toISOString();
  const statusKey = (batchId: string) => ({ batchId, effect: 'status.1' });
  const factsOf = (store: EventStore, effects: Pick<DriverEffects, 'due'> = { due: () => [] }) =>
    storeFacts(effects, store, () => at)(createCommandLog({ store, recipes }).state());

  it('counts an effect due while its key is not in the ledger, or while a source throws', () => {
    const store = openSqliteEventStore(':memory:');
    store.withTransaction((tx) => {
      tx.append({ type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy });
      tx.append({ type: 'batch.ordered', batchId: '2-1', order: { issue: 2 }, routeBy });
      tx.recordEffect(statusKey('2-1'), { comment: 1, digest: '0123456789abcdef' });
    });
    const facts = factsOf(store, {
      due: (_state, batchId) => {
        if (batchId === '3-1') throw new Error('the source cannot read');
        return [statusKey(batchId)];
      },
    });
    assert.equal(facts.due('1-1'), true);
    assert.equal(facts.due('2-1'), false);
    assert.equal(facts.due('3-1'), true);
    store.close();
  });

  it('counts a batch leased by its own lease or by a live lease of one of its attempts', () => {
    const store = openSqliteEventStore(':memory:');
    store.withTransaction((tx) => {
      tx.putBatchLease({ batchId: '1-1', owner: 'cellar', expiresAt: later });
      tx.putLease({
        attemptKey: attemptKey.encode({ batchId: '2-1', stepId: 'plan', attempt: 1 }),
        owner: 'cellar',
        expiresAt: later,
      });
      tx.putBatchLease({ batchId: '3-1', owner: 'cellar', expiresAt: at });
    });
    assert.deepStrictEqual([...factsOf(store).leased].sort(), ['1-1', '2-1']);
    store.close();
  });

  it('counts a batch not pushed while the branch lacks one of its events, or an out doc of it is kept', () => {
    const store = openSqliteEventStore(':memory:');
    store.withTransaction((tx) => {
      tx.append({ type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy });
      tx.append({ type: 'batch.ordered', batchId: '2-1', order: { issue: 2 }, routeBy });
      tx.append({ type: 'batch.ordered', batchId: '3-1', order: { issue: 3 }, routeBy });
      tx.markPushed({ eventId: 2, commit: 'c'.repeat(40) });
      tx.keepOutDoc({ batchId: '2-1', stepId: 'plan', attempt: 1, text: '# Plan\n' });
    });
    const facts = factsOf(store);
    assert.equal(facts.unpushed('1-1'), false);
    assert.equal(facts.unpushed('2-1'), true);
    assert.equal(facts.unpushed('3-1'), true);
    store.close();
  });
});
