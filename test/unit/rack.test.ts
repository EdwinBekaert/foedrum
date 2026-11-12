import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { type ArchiveShelf, rackActions } from '../../src/engine/rack.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const day = 24 * hour;
const now = new Date('2026-11-12T12:00:00.000Z');
const brewery = 'acme/brewery';
const recipes = fakeRecipes({
  rack: fakeRecipe({
    steps: ['approval', 'archive', 'delete-archives', 'delete-temporary'],
    actions: {
      approval: 'gate',
      archive: 'archive',
      'delete-archives': 'deleteArchives',
      'delete-temporary': 'deleteTemporary',
    },
    olderThan: { 'delete-archives': 180 * day, 'delete-temporary': 2 * day },
    pullRequests: [],
  }),
});

const ordered = (batchId: string, issue: number, parentBatchId?: string): Event[] => [
  {
    type: 'batch.ordered',
    batchId,
    order: { issue },
    routeBy: '2026-12-31T00:00:00.000Z',
    ...(parentBatchId === undefined ? {} : { parentBatchId }),
  },
  { type: 'batch.recipe_chosen', batchId, recipe: 'rack', reason: 'label', source: 'label' },
];
const at = (batchId: string, stepId: string): Event[] => [
  { type: 'step.scheduled', batchId, stepId, attempt: 1, deadlineAt: '2026-11-12T13:00:00.000Z' },
  { type: 'step.started', batchId, stepId, attempt: 1 },
];
/** A batch on tap with no pull request: a rack batch, finished once its issue is closed. */
const onTap = (batchId: string, issue: number, parentBatchId?: string): Event[] => [
  ...ordered(batchId, issue, parentBatchId),
  { type: 'batch.on_tap', batchId, pullRequests: [] },
];
const brewing = (batchId: string, issue: number, parentBatchId?: string): Event[] => [
  ...ordered(batchId, issue, parentBatchId),
  ...at(batchId, 'archive'),
];
/** The rack batch that runs `stepId`, issue 20. */
const racking = (stepId: string): Event[] => [...ordered('20-1', 20), ...at('20-1', stepId)];

/** A shelf that keeps what it was asked. */
const fakeShelf = (dates: readonly string[] = []) => {
  const shelved: { batchIds: readonly string[]; date: string; known: string[] }[] = [];
  const dropped: string[][] = [];
  const shelf: ArchiveShelf = {
    shelve: async (batchIds, date, known) => {
      shelved.push({ batchIds, date, known: [...known].sort() });
    },
    dates: async () => [...dates],
    drop: async (gone) => {
      dropped.push([...gone]);
    },
  };
  return { shelf, shelved, dropped };
};

/** Runs the rack step `stepId` over `events`, its issues' states as `closed` names them. */
const run = async (
  stepId: string,
  events: readonly Event[],
  closed: readonly number[],
  options: { dates?: readonly string[]; temporary?: string } = {},
) => {
  const store = openSqliteEventStore(':memory:');
  store.withTransaction((tx) => {
    for (const event of [...events, ...racking(stepId)]) tx.append(event);
  });
  const state = () => fold(store.eventsAfter(0).map(({ event }) => event));
  const { shelf, shelved, dropped } = fakeShelf(options.dates);
  const reads: string[] = [];
  const actions = rackActions({
    brewery,
    recipes,
    state,
    store,
    shelf,
    issueState: async (repo, issue) => {
      reads.push(`${repo}#${issue}`);
      return closed.includes(issue) ? 'closed' : 'open';
    },
    temporary: options.temporary ?? join('nowhere', '.foedrum', 'tmp'),
    clock: () => now,
  });
  const ref: AttemptRef = { batchId: '20-1', stepId, attempt: 1 };
  for (const key of actions.due(state(), ref)) await actions.target.apply(effectKey.encode(key));
  const batches = [
    ...new Set(store.eventsAfter(0).map(({ event }) => ('batchId' in event ? event.batchId : ''))),
  ];
  store.close();
  return { batches, shelved, dropped, reads };
};

describe('rack (ADR 0383)', () => {
  it('rack moves a finished batch to the archive and out of the store', async () => {
    const ran = await run('archive', [...onTap('6-1', 6), ...onTap('6-2', 6)], [6]);
    assert.deepStrictEqual(ran.batches, ['20-1']);
    assert.deepStrictEqual(ran.shelved, [
      { batchIds: ['6-1', '6-2'], date: '2026-11-12', known: ['20-1'] },
    ]);
    assert.deepStrictEqual(ran.reads, [`${brewery}#6`]);
  });

  it('rack leaves a batch that has not finished', async () => {
    // 7's issue is still open; 8 brews; 9 is archived beside them.
    const events = [...onTap('7-1', 7), ...brewing('8-1', 8), ...onTap('9-1', 9)];
    const ran = await run('archive', events, [8, 9]);
    assert.deepStrictEqual(ran.batches, ['7-1', '8-1', '20-1']);
    assert.deepStrictEqual(ran.shelved, [
      { batchIds: ['9-1'], date: '2026-11-12', known: ['20-1', '7-1', '8-1'] },
    ]);
    assert.ok(!ran.reads.includes(`${brewery}#8`), 'a batch that brews needs no read');
  });

  it('rack archives a split order only with all its sub-orders', async () => {
    const decomposed: Event = {
      type: 'order.decomposed',
      batchId: '10-1',
      subOrders: [
        { issue: 11, repo: 'acme/api' },
        { issue: 12, repo: 'acme/api' },
      ],
      dependencies: [],
    };
    const order = [
      ...ordered('10-1', 10),
      decomposed,
      { type: 'batch.on_tap', batchId: '10-1', pullRequests: [] } satisfies Event,
    ];
    const waiting = await run(
      'archive',
      [...order, ...onTap('11-1', 11, '10-1'), ...brewing('12-1', 12, '10-1')],
      [10, 11, 12],
    );
    assert.deepStrictEqual(waiting.batches, ['10-1', '11-1', '12-1', '20-1']);
    const done = await run(
      'archive',
      [...order, ...onTap('11-1', 11, '10-1'), ...onTap('12-1', 12, '10-1')],
      [10, 11, 12],
    );
    assert.deepStrictEqual(done.batches, ['20-1']);
    assert.deepStrictEqual(
      done.shelved.map(({ batchIds }) => batchIds),
      [['10-1', '11-1', '12-1']],
    );
  });

  it('rack deletes archive folders older than 180 days', async () => {
    // Its newest batch was archived at the end of its day: 2026-05-15's is 180 days old at midnight.
    const dates = ['2026-11-01', '2026-05-16', '2026-05-14', '2026-05-15'];
    const ran = await run('delete-archives', [], [], { dates });
    assert.deepStrictEqual(ran.dropped, [['2026-05-14', '2026-05-15']]);
  });

  describe('temporary files', () => {
    let dir: TempDir;
    beforeEach(() => {
      dir = makeTempDir('rack');
    });
    afterEach(() => dir.remove());

    it('rack deletes temporary files older than 2 days', async () => {
      const file = (path: string, ageMs: number) => {
        const full = join(dir.path, path);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, 'x');
        const time = new Date(now.getTime() - ageMs);
        utimesSync(full, time, time);
        return full;
      };
      const old = file('old.txt', 3 * day);
      const recent = file('recent.txt', day);
      const nested = file(join('921', 'run.log'), 3 * day);
      const empty = join(dir.path, 'empty');
      mkdirSync(empty);
      await run('delete-temporary', [], [], { temporary: dir.path });
      assert.equal(existsSync(old), false);
      assert.equal(existsSync(nested), false);
      assert.equal(existsSync(join(dir.path, '921')), false, 'a folder it emptied goes');
      assert.equal(existsSync(recent), true);
      assert.equal(existsSync(empty), true, 'a folder it did not empty stays');
    });
  });
});
