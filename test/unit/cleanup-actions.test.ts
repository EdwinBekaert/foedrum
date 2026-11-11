// A cleanup recipe's actions run by the driver (ADR 0380): its archive step archives every batch
// the cleanup may take, its sweep step clears the Brewery's temporary folder, and its batch goes on
// tap with no pull request.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ArchiveFacts } from '../../src/engine/archive.ts';
import { actionsByKind, cleanupActions } from '../../src/engine/cleanup-actions.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, type DriverActions, openDriver } from '../../src/engine/driver.ts';
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
});
