// A cleanup recipe's actions run by the driver (ADR 0380): its archive step archives every batch
// the cleanup may take, its sweep step clears the Brewery's temporary folder, and its batch goes on
// tap with no pull request.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ArchiveFacts } from '../../src/engine/archive.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { actionsByKind, cleanupActions, storeFacts } from '../../src/engine/cleanup-actions.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, type DriverActions, openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
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
    steps: ['archive', 'sweep'],
    actions: { archive: 'archive', sweep: 'sweep' },
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
  const noFacts = (): ArchiveFacts => ({ due: () => false, leased: new Set() });
  const run = async (driver: Driver): Promise<void> => {
    for (let n = 0; n < 6; n++) await driver.tick();
  };

  it('the cleanup recipe archives every finished batch, sweeps the temporary folder and ends on tap', async () => {
    order('1-1', 'pint');
    issue({ kind: 'cancel', batchId: '1-1', ...who });
    issue({ kind: 'order', batchId: '2-1', order: { issue: 2 } });
    order('9-1', 'cleanup');
    scratch('old.txt', TEMP_AGE_MS + 60_000);
    scratch('new.txt', 60_000);

    const actions = cleanupActions({ recipes, log, facts: noFacts, temp, clock: () => at });
    await run(await open(actions));

    const state = log.state();
    assert.deepStrictEqual([...state.archived.keys()], ['1-1']);
    assert.deepStrictEqual([...state.batches.keys()], ['2-1', '9-1']);
    assert.deepStrictEqual(state.batches.get('9-1')?.lane, { kind: 'on_tap', pullRequests: [] });
    assert.equal(existsSync(join(temp, 'old.txt')), false);
    assert.equal(existsSync(join(temp, 'new.txt')), true);
    assert.deepStrictEqual(
      store.findEffect({ batchId: '9-1', stepId: 'archive', attempt: 1, effect: 'archive' })
        ?.result,
      { archived: ['1-1'] },
    );
    assert.deepStrictEqual(
      store.findEffect({ batchId: '9-1', stepId: 'sweep', attempt: 1, effect: 'sweep' })?.result,
      { removed: ['old.txt'], failed: [] },
    );
  });

  it('leaves a finished batch the facts say has an effect due', async () => {
    order('1-1', 'pint');
    issue({ kind: 'cancel', batchId: '1-1', ...who });
    order('9-1', 'cleanup');
    const facts = (): ArchiveFacts => ({ due: (id) => id === '1-1', leased: new Set() });

    await run(await open(cleanupActions({ recipes, log, facts, temp, clock: () => at })));

    assert.deepStrictEqual([...log.state().archived.keys()], []);
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
      archive: named('archive'),
      sweep: named('sweep'),
    });

    await run(await open(actions));

    assert.deepStrictEqual([...new Set(asked)], ['archive', 'sweep']);
    assert.equal(log.state().batches.get('9-1')?.lane.kind, 'on_tap');
  });

  it("applies each effect with the actions whose due gave it, a pull request's never asked: regression test", async () => {
    order('1-1', 'pint');
    issue({ kind: 'cancel', batchId: '1-1', ...who });
    order('9-1', 'cleanup');
    scratch('old.txt', TEMP_AGE_MS + 60_000);
    const refusing: DriverActions = {
      due: () => assert.fail('no pull request step runs'),
      target: { find: () => assert.fail('found'), apply: () => assert.fail('applied') },
      ending: () => assert.fail('ended'),
    };
    const tends = cleanupActions({ recipes, log, facts: noFacts, temp, clock: () => at });
    const actions = actionsByKind(recipes, {
      openPullRequest: refusing,
      archive: tends,
      sweep: tends,
    });

    await run(await open(actions));

    assert.deepStrictEqual([...log.state().archived.keys()], ['1-1']);
    assert.equal(existsSync(join(temp, 'old.txt')), false);
    assert.deepStrictEqual(log.state().batches.get('9-1')?.lane, {
      kind: 'on_tap',
      pullRequests: [],
    });
  });

  it('records only the archives the store accepted: regression test', async () => {
    order('1-1', 'pint');
    issue({ kind: 'cancel', batchId: '1-1', ...who });
    order('9-1', 'cleanup');
    // A store that refuses every record, as when another driver archived the batch first.
    const refusing: CommandLog = {
      state: () => log.state(),
      issue: () => ({ kind: 'refused', reason: 'batch 1-1 is archived' }),
    };
    const actions = cleanupActions({
      recipes,
      log: refusing,
      facts: noFacts,
      temp,
      clock: () => at,
    });
    const key = { batchId: '9-1', stepId: 'archive', attempt: 1, effect: 'archive' };
    const ref = { batchId: '9-1', stepId: 'archive', attempt: 1 };
    assert.deepStrictEqual(actions.due(log.state(), ref), [key]);
    assert.deepStrictEqual(await actions.target.apply(effectKey.encode(key)), {
      archived: [],
    });
  });

  it('fails an ending, retryably, whose ledger has no result of its action: regression test', () => {
    order('9-1', 'cleanup');
    const actions = cleanupActions({ recipes, log, facts: noFacts, temp, clock: () => at });
    const ending = actions.ending(log.state(), { batchId: '9-1', stepId: 'sweep', attempt: 1 });
    assert.equal(ending.kind === 'failed' && ending.retryable, true);
  });
});

describe('storeFacts (ADR 0380)', () => {
  const at = new Date('2026-11-11T12:00:00.000Z');
  const later = new Date(at.getTime() + 60_000);
  const statusKey = (batchId: string) => ({ batchId, effect: 'status.1' });

  it('counts an effect due while its key is not in the ledger, or while a source throws', () => {
    const store = openSqliteEventStore(':memory:');
    store.withTransaction((tx) => {
      tx.append({
        type: 'batch.ordered',
        batchId: '1-1',
        order: { issue: 1 },
        routeBy: at.toISOString(),
      });
      tx.append({
        type: 'batch.ordered',
        batchId: '2-1',
        order: { issue: 2 },
        routeBy: at.toISOString(),
      });
      tx.recordEffect(statusKey('2-1'), { comment: 1, digest: '0123456789abcdef' });
    });
    const effects = {
      due: (_state: unknown, batchId: string) => {
        if (batchId === '3-1') throw new Error('the source cannot read');
        return [statusKey(batchId)];
      },
    };
    const facts = storeFacts(
      effects,
      store,
      () => at,
    )(createCommandLog({ store, recipes }).state());
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
    const facts = storeFacts(
      { due: () => [] },
      store,
      () => at,
    )(createCommandLog({ store, recipes }).state());
    assert.deepStrictEqual([...facts.leased].sort(), ['1-1', '2-1']);
    store.close();
  });
});
