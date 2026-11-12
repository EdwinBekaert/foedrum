import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import { claimEffectsDue } from '../../src/engine/issue-claims.ts';
import { type ArchiveShelf, rackActions, withRack } from '../../src/engine/rack.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { batchOf } from '../../src/engine/state-branch.ts';
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
/**
 * A batch on tap with no pull request: a rack batch, finished once its issue is closed, whose close
 * the driver applied when it ran (ADR 0387).
 */
const onTap = (batchId: string, issue: number, parentBatchId?: string): Event[] => [
  ...ordered(batchId, issue, parentBatchId),
  { type: 'batch.on_tap', batchId, pullRequests: [] },
  { type: 'effect.applied', key: JSON.stringify([batchId, 'close.comment']), result: 1 },
  { type: 'effect.applied', key: JSON.stringify([batchId, 'close.issue']), result: null },
];
const brewing = (batchId: string, issue: number, parentBatchId?: string): Event[] => [
  ...ordered(batchId, issue, parentBatchId),
  ...at(batchId, 'archive'),
];
const pullRequest = 'https://github.com/acme/api/pull/3';
/** The status comment's revision that shows a batch ended (ADR 0345). */
const shown = (batchId: string): Event => ({
  type: 'effect.applied',
  key: JSON.stringify([batchId, 'status.1']),
  result: { comment: 1, digest: '0123456789abcdef' },
});
const applied = (batchId: string, effect: string): Event => ({
  type: 'effect.applied',
  key: JSON.stringify([batchId, effect]),
  result: null,
});
const cancelled = (batchId: string, issue: number, repo?: string): Event[] => [
  {
    type: 'batch.ordered',
    batchId,
    order: repo === undefined ? { issue } : { issue, repo },
    routeBy: '2026-12-31T00:00:00.000Z',
  },
  { type: 'batch.cancelled', batchId, by: 'ada', via: 'terminal' },
];
/** A batch on tap with one pull request, merged when `merged`. */
const opened = (batchId: string, issue: number, merged: boolean): Event[] => [
  ...ordered(batchId, issue),
  { type: 'batch.on_tap', batchId, pullRequests: [pullRequest] },
  ...(merged
    ? [{ type: 'pull_request.ended', batchId, pullRequest, state: 'merged' } satisfies Event]
    : []),
];
/** The release effects of the claimed, cancelled batch `batchId` of acme/api#`issue`, applied. */
const released = (batchId: string, issue: number): Event[] =>
  claimEffectsDue(
    { batchId, repo: 'acme/api', issue, lane: { kind: 'cancelled', by: 'ada', via: 'terminal' } },
    { brewery: 'acme/api', login: '' },
    () => 'open',
  ).map(({ key }) => ({ type: 'effect.applied', key: effectKey.encode(key), result: null }));

/** The rack batch that runs `stepId`, issue 20. */
const racking = (stepId: string): Event[] => [...ordered('20-1', 20), ...at('20-1', stepId)];

/** A shelf that keeps what it was asked. */
const fakeShelf = (
  ids: () => readonly string[],
  dates: readonly string[] = [],
  waiting: () => void = () => {},
) => {
  const shelved: { batchIds: readonly string[]; date: string; known: string[] }[] = [];
  const dropped: string[][] = [];
  const shelf: ArchiveShelf = {
    shelve: async (batchIds, date, known) => {
      // As the state branch's shelve waits for its writer lock.
      await Promise.resolve();
      waiting();
      shelved.push({ batchIds, date, known: ids().filter(known).sort() });
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
  options: {
    dates?: readonly string[];
    temporary?: string;
    /** An issue's state by `<repo>#<n>`, over what `closed` says. */
    states?: Readonly<Record<string, 'open' | 'closed' | 'gone'>>;
    /** What happens while issue `issue` is read: a write to the store, or a failed read. */
    reading?: (store: EventStore, issue: number) => void;
    /** What happens while the shelf waits for its lock: a write to the store. */
    shelving?: (store: EventStore) => void;
    /** How far the clock moves at each issue read, in milliseconds. */
    readMs?: number;
  } = {},
) => {
  const store = openSqliteEventStore(':memory:');
  store.withTransaction((tx) => {
    for (const event of [...events, ...racking(stepId)]) tx.append(event);
  });
  const state = () => fold(store.eventsAfter(0).map(({ event }) => event));
  const { shelf, shelved, dropped } = fakeShelf(
    () => [...new Set(store.eventsAfter(0).flatMap(({ event }) => batchOf(event) ?? []))],
    options.dates,
    () => options.shelving?.(store),
  );
  const reads: string[] = [];
  // How many batches each forget took.
  const forgets: number[] = [];
  let elapsed = 0;
  const actions = rackActions({
    brewery,
    recipes,
    state,
    store: {
      forget: (batchIds) => {
        forgets.push(batchIds.length);
        store.forget(batchIds);
      },
    },
    shelf,
    issueState: async (repo, issue) => {
      reads.push(`${repo}#${issue}`);
      elapsed += options.readMs ?? 0;
      options.reading?.(store, issue);
      return options.states?.[`${repo}#${issue}`] ?? (closed.includes(issue) ? 'closed' : 'open');
    },
    temporary: options.temporary ?? join('nowhere', '.foedrum', 'tmp'),
    clock: () => new Date(now.getTime() + elapsed),
  });
  const ref: AttemptRef = { batchId: '20-1', stepId, attempt: 1 };
  let failed: unknown;
  for (const key of actions.due(state(), ref)) {
    try {
      const result = await actions.target.apply(effectKey.encode(key));
      store.withTransaction((tx) => tx.recordEffect(key, result));
    } catch (error) {
      failed = error;
    }
  }
  const ending = actions.ending(state(), ref);
  const batches = [...new Set(store.eventsAfter(0).map(({ event }) => batchOf(event)))];
  store.close();
  return { batches, shelved, dropped, reads, ending, failed, forgets };
};

describe('rack (ADR 0383)', () => {
  it('rack moves a finished batch to the archive and out of the store', async () => {
    const ran = await run('archive', [...onTap('6-1', 6), ...onTap('6-2', 6)], [6]);
    assert.deepStrictEqual(ran.batches, ['20-1']);
    assert.deepStrictEqual(ran.shelved, [
      { batchIds: ['6-1', '6-2'], date: '2026-11-12', known: ['20-1'] },
    ]);
    assert.deepStrictEqual(ran.reads, [`${brewery}#6`]);
    // Its out doc is what its effect did.
    assert.deepStrictEqual(ran.ending, { kind: 'succeeded', output: { archived: ['6-1', '6-2'] } });
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
    // A run that archives nothing still moves what a crash left in batches/.
    assert.deepStrictEqual(
      waiting.shelved.map(({ batchIds }) => batchIds),
      [[]],
    );
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

  it('leaves each batch one condition keeps: regression test', async () => {
    const events = [
      // On tap with an open pull request.
      ...opened('1-1', 1, false),
      // Cancelled, its comment not showing it yet.
      ...cancelled('2-1', 2),
      // Merged and shown, its issue's close still due.
      ...opened('3-1', 3, true),
      shown('3-1'),
      // Claimed and cancelled, its claim not released.
      ...cancelled('acme-4', 4, 'acme/api'),
      shown('acme-4'),
      // The same three with what each lacked: these go.
      ...opened('5-1', 5, true),
      shown('5-1'),
      applied('5-1', 'close.comment'),
      applied('5-1', 'close.issue'),
      ...cancelled('6-1', 6),
      shown('6-1'),
      ...cancelled('acme-7', 7, 'acme/api'),
      shown('acme-7'),
      ...released('acme-7', 7),
    ];
    const ran = await run('archive', events, [1, 2, 3, 4, 5, 6, 7]);
    assert.deepStrictEqual(ran.batches, ['1-1', '2-1', '3-1', 'acme-4', '20-1']);
    assert.deepStrictEqual(ran.shelved[0]?.batchIds, ['5-1', '6-1', 'acme-7']);
  });

  it('archives the batches of an issue together, an issue by its repository too: regression test', async () => {
    const events = [
      // 8's older batch is finished, its later one brews: neither goes.
      ...onTap('8-1', 8),
      ...brewing('8-2', 8),
      // Brewery issue 9 is finished; acme/api#9, another issue, has not ended its comment.
      ...onTap('9-1', 9),
      ...cancelled('acme-9', 9, 'acme/api'),
      // A claimed batch whose target issue is open stays; a deleted issue counts as closed.
      ...cancelled('acme-10', 10, 'acme/api'),
      shown('acme-10'),
      ...released('acme-10', 10),
      ...onTap('11-1', 11),
    ];
    const states = { 'acme/api#10': 'open', [`${brewery}#11`]: 'gone' } as const;
    const ran = await run('archive', events, [8, 9, 10], { states });
    assert.deepStrictEqual(ran.batches, ['8-1', '8-2', 'acme-9', 'acme-10', '20-1']);
    assert.deepStrictEqual(ran.shelved[0]?.batchIds, ['9-1', '11-1']);
  });

  it('rack reads a Brewery issue and a claimed issue with the same number apart', async () => {
    // Brewery issue 10 is closed; acme/api#10, read after it, is open: its batch stays.
    const events = [
      ...onTap('10-1', 10),
      ...cancelled('acme-10', 10, 'acme/api'),
      shown('acme-10'),
      ...released('acme-10', 10),
    ];
    const ran = await run('archive', events, [10], { states: { 'acme/api#10': 'open' } });
    assert.deepStrictEqual(ran.reads, [`${brewery}#10`, 'acme/api#10']);
    assert.deepStrictEqual(ran.batches, ['acme-10', '20-1']);
    assert.deepStrictEqual(ran.shelved[0]?.batchIds, ['10-1']);
  });

  it('sends each action attempt to its own actions, and each effect to its own target: regression test', async () => {
    const both = fakeRecipes({
      ale: fakeRecipe({ steps: ['open'], actions: { open: 'openPullRequest' }, pullRequests: [] }),
      rack: fakeRecipe({ steps: ['archive'], actions: { archive: 'archive' }, pullRequests: [] }),
    });
    const fake = (name: string) => ({
      due: () => [{ batchId: name, effect: name }],
      target: { find: async () => undefined, apply: async () => name },
      ending: () => ({ kind: 'succeeded', output: name }) as const,
    });
    const actions = withRack(both, fake('open'), fake('rack'));
    const state = fold([
      ...ordered('1-1', 1),
      { type: 'batch.recipe_chosen', batchId: '1-1', recipe: 'ale', reason: 'l', source: 'label' },
      ...at('1-1', 'open'),
      ...ordered('2-1', 2),
      ...at('2-1', 'archive'),
    ]);
    const open = { batchId: '1-1', stepId: 'open', attempt: 1 };
    const archive = { batchId: '2-1', stepId: 'archive', attempt: 1 };
    assert.deepStrictEqual(
      [actions.due(state, open), actions.due(state, archive)],
      [[{ batchId: 'open', effect: 'open' }], [{ batchId: 'rack', effect: 'rack' }]],
    );
    assert.equal(await actions.target.apply(JSON.stringify(['2-1', 'rack.archive'])), 'rack');
    assert.equal(await actions.target.apply(JSON.stringify(['1-1', 'push'])), 'open');
  });

  it('keeps the groups it archived before an issue could not be read, so each run gets further', async () => {
    const reading = (_store: EventStore, issue: number) => {
      if (issue === 7) throw new Error('GitHub did not answer');
    };
    const ran = await run('archive', [...onTap('6-1', 6), ...onTap('7-1', 7)], [6, 7], { reading });
    assert.match(String(ran.failed), /GitHub did not answer/);
    assert.deepStrictEqual(ran.batches, ['7-1', '20-1']);
  });

  it('forgets the groups it read in chunks, not one by one, so a long history costs few folds', async () => {
    const issues = Array.from({ length: 60 }, (_, i) => 100 + i);
    const events = issues.flatMap((issue) => onTap(`${issue}-1`, issue));
    const ran = await run('archive', events, issues);
    assert.deepStrictEqual(ran.forgets, [25, 25, 10]);
    assert.deepStrictEqual(ran.batches, ['20-1']);
  });

  it('forgets what it read once 20 s passed since the last forget, before a chunk is full', async () => {
    const events = [...onTap('6-1', 6), ...onTap('7-1', 7), ...onTap('8-1', 8)];
    const ran = await run('archive', events, [6, 7, 8], { readMs: 11_000 });
    assert.deepStrictEqual(ran.forgets, [2, 1]);
  });

  it('counts as known a batch ordered while the shelf waited for its lock, so its folder stays', async () => {
    const shelving = (store: EventStore) =>
      store.withTransaction((tx) => {
        for (const event of ordered('30-1', 30)) tx.append(event);
      });
    const ran = await run('archive', onTap('6-1', 6), [6], { shelving });
    assert.deepStrictEqual(ran.shelved[0]?.known, ['20-1', '30-1']);
  });

  it('leaves a group a batch joined while its issues were read', async () => {
    // Issue 7 is ordered again while rack reads it: 7-1 no longer goes alone.
    const reading = (store: EventStore, issue: number) => {
      if (issue !== 7) return;
      store.withTransaction((tx) => {
        for (const event of brewing('7-2', 7)) tx.append(event);
      });
    };
    const ran = await run('archive', [...onTap('6-1', 6), ...onTap('7-1', 7)], [6, 7], { reading });
    assert.deepStrictEqual(ran.batches, ['7-1', '20-1', '7-2']);
    assert.deepStrictEqual(ran.shelved[0]?.batchIds, ['6-1']);
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
      const ran = await run('delete-temporary', [], [], { temporary: dir.path });
      // Its out doc says how many it deleted.
      assert.deepStrictEqual(ran.ending, { kind: 'succeeded', output: { deleted: 2 } });
      assert.equal(existsSync(old), false);
      assert.equal(existsSync(nested), false);
      assert.equal(existsSync(join(dir.path, '921')), false, 'a folder it emptied goes');
      assert.equal(existsSync(recent), true);
      assert.equal(existsSync(empty), true, 'a folder it did not empty stays');
    });

    it('deletes nothing, and ends, when the Brewery has no .foedrum/tmp yet (ADR 0383): regression test', async () => {
      const ran = await run('delete-temporary', [], [], { temporary: join(dir.path, 'none') });
      assert.deepStrictEqual(ran.ending, { kind: 'succeeded', output: { deleted: 0 } });
    });

    it('never follows a link out of the temporary folder (ADR 0383): regression test', async () => {
      const outside = makeTempDir('rack-outside');
      try {
        const kept = join(outside.path, 'old.txt');
        writeFileSync(kept, 'x');
        const time = new Date(now.getTime() - 3 * day);
        utimesSync(kept, time, time);
        // A junction on Windows, a symbolic link elsewhere: neither needs a privilege.
        symlinkSync(outside.path, join(dir.path, 'link'), 'junction');
        await run('delete-temporary', [], [], { temporary: dir.path });
        assert.equal(existsSync(kept), true);
      } finally {
        outside.remove();
      }
    });
  });
});
