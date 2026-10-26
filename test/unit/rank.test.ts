// Ranks (ADR 0208): the intake orders and claims its queue by arrival across the Brewery and its
// target repositories, unless a person moved an order with `foedrum rank`. A fake tracker and a
// fake GitHub, no network (ADR 0021).

import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CliContext, type CliResult, runCli } from '../../src/cli/run.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { RankOrder } from '../../src/engine/decide.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import { createIntake, type IntakeOptions, type TargetTracker } from '../../src/engine/intake.ts';
import type { Claimant, TargetIssue } from '../../src/engine/issue-claims.ts';
import { placeAt, type QueuedOrder, rankQueue } from '../../src/engine/ranks.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { BreweryConfig } from '../../src/schemas/brewery-config.ts';
import type { Event, OrderRef, RankPlace } from '../../src/schemas/events.ts';
import { linux } from '../helpers/doctor-facts.ts';
import { type FakeGitHub, fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const web = 'acme/web';
const api = 'acme/api';
const t0 = new Date('2026-10-20T12:00:00.000Z');
/** `minutes` after 10:00 on the day of t0. */
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 20, 10, minutes)).toISOString();
const alice: Claimant = { brewery, login: 'alice' };
const bob: Claimant = { brewery: 'bob/brewery', login: 'bob' };
const recipes = fakeRecipes({ half: fakeRecipe({ steps: ['plan'] }) });

const issue = (
  number: number,
  created: string,
  fields: Partial<TargetIssue> = {},
): TargetIssue => ({
  number,
  state: 'open',
  pullRequest: false,
  labels: ['foedrum'],
  milestone: undefined,
  assignees: [],
  author: 'alice',
  created,
  ...fields,
});
const labelled = (number: number, created: string): TargetIssue =>
  issue(number, created, { labels: ['recipe:half'] });

// web#8 came first, then api#2, the Brewery's #12, web#7 and the Brewery's #13.
const listings = (): Record<string, TargetIssue[]> => ({
  [brewery]: [labelled(13, at(5)), labelled(12, at(3))],
  [web]: [issue(7, at(4)), issue(8, at(1))],
  [api]: [issue(2, at(2))],
});
const fakeTracker = (issues: Record<string, TargetIssue[]>): TargetTracker => ({
  issues: async (repo) => {
    const listed = issues[repo];
    if (listed === undefined) throw new Error(`502 listing ${repo}`);
    return listed;
  },
  pullRequest: async () => 'open',
});

const ranked = (order: OrderRef, place: RankPlace, why?: string): Event => ({
  type: 'order.ranked',
  order,
  place,
  by: 'ada',
  via: 'terminal',
  ...(why === undefined ? {} : { why }),
});
const rank = (order: OrderRef, place: RankPlace): RankOrder => ({
  kind: 'rank',
  order,
  place,
  by: 'ada',
  via: 'terminal',
});
const first: RankPlace = { kind: 'first' };
const position = (n: number, arrival: string, tie = 0): RankPlace => ({
  kind: 'position',
  position: n,
  arrival,
  tie,
});

describe('rankQueue', () => {
  const queued = (order: OrderRef, created: string, source: number): QueuedOrder => ({
    order,
    created,
    source,
  });
  // web is the first repository foedrum.jsonc lists, api the second.
  const queue = [
    queued({ issue: 3, repo: web }, at(2), 1),
    queued({ issue: 12 }, at(1), 0),
    queued({ issue: 2, repo: api }, at(1), 2),
    queued({ issue: 1, repo: web }, at(1), 1),
    queued({ issue: 1, repo: api }, at(0), 2),
  ];
  const names = (sorted: readonly QueuedOrder[]) =>
    sorted.map(({ order }) => `${order.repo ?? ''}#${order.issue}`);
  const ranksOf = (...events: Event[]) => fold(events).ranks;

  it('sorts by arrival across the Brewery and its repositories, the Brewery, config order and number breaking a tie', () => {
    assert.deepStrictEqual(names(rankQueue(queue, ranksOf())), [
      'acme/api#1',
      '#12',
      'acme/web#1',
      'acme/api#2',
      'acme/web#3',
    ]);
  });

  it('puts a ranked order at its arrival, ahead of the unranked ones that share it, the lower tie ahead', () => {
    const ranks = ranksOf(
      ranked({ issue: 3, repo: web }, position(1, at(0))),
      ranked({ issue: 2, repo: api }, position(1, at(0), -1)),
    );
    assert.deepStrictEqual(names(rankQueue(queue, ranks)), [
      'acme/api#2',
      'acme/web#3',
      'acme/api#1',
      '#12',
      'acme/web#1',
    ]);
  });

  it('puts the orders marked first ahead of every other, by when they were marked', () => {
    const ranks = ranksOf(
      ranked({ issue: 3, repo: web }, position(1, at(0))),
      ranked({ issue: 12 }, first),
      ranked({ issue: 2, repo: api }, first),
    );
    assert.deepStrictEqual(names(rankQueue(queue, ranks)), [
      '#12',
      'acme/api#2',
      'acme/web#3',
      'acme/api#1',
      'acme/web#1',
    ]);
  });

  it('keeps only the latest rank of an order: marked again, it goes behind the other marked ones', () => {
    const marked = [
      ranked({ issue: 12 }, first),
      ranked({ issue: 2, repo: api }, first),
      ranked({ issue: 12 }, first),
    ];
    assert.deepStrictEqual(names(rankQueue(queue, ranksOf(...marked))).slice(0, 2), [
      'acme/api#2',
      '#12',
    ]);
    // Then moved behind the rest: the mark is gone.
    const moved = ranksOf(...marked, ranked({ issue: 12 }, position(9, at(5))));
    assert.equal(moved.size, 2);
    assert.deepStrictEqual(names(rankQueue(queue, moved)), [
      'acme/api#2',
      'acme/api#1',
      'acme/web#1',
      'acme/web#3',
      '#12',
    ]);
  });

  it("matches an order's rank by its repository in any case", () => {
    const ranks = ranksOf(ranked({ issue: 3, repo: 'Acme/Web' }, first));
    assert.deepStrictEqual(names(rankQueue(queue, ranks))[0], 'acme/web#3');
  });

  describe('placeAt', () => {
    const order = { issue: 3, repo: web };

    it('gives the arrival of the order now at the place, leaving the ranked order out', () => {
      const sorted = rankQueue(queue, ranksOf());
      assert.deepStrictEqual(placeAt(sorted, ranksOf(), order, 1, t0), { arrival: at(0), tie: 0 });
      assert.deepStrictEqual(placeAt(sorted, ranksOf(), order, 3, t0), { arrival: at(1), tie: 0 });
      // Its own place does not count: web#3 is fifth, so place 5 is past the other four.
      assert.deepStrictEqual(placeAt(sorted, ranksOf(), order, 5, t0), {
        arrival: t0.toISOString(),
        tie: 0,
      });
    });

    it('counts only the orders without the mark, and a ranked one by its rank and tie', () => {
      const ranks = ranksOf(
        ranked({ issue: 1, repo: api }, first),
        ranked({ issue: 2, repo: api }, position(1, at(0))),
      );
      const sorted = rankQueue(queue, ranks);
      // api#1 is marked: place 1 is api#2, ranked at 10:00 with tie 0, so it goes ahead of that.
      assert.deepStrictEqual(placeAt(sorted, ranks, order, 1, t0), { arrival: at(0), tie: -1 });
      assert.deepStrictEqual(placeAt(sorted, ranks, order, 2, t0), { arrival: at(1), tie: 0 });
    });

    it('puts an order between a ranked order and the order behind it that share an arrival', () => {
      // api#2 ranked at its own arrival, 10:01: api#1, api#2, #12, web#1, web#3.
      const ranks = ranksOf(ranked({ issue: 2, repo: api }, position(2, at(1))));
      const sorted = rankQueue(queue, ranks);
      const place = placeAt(sorted, ranks, order, 3, t0);
      assert.deepStrictEqual(place, { arrival: at(1), tie: 1 });
      const moved = ranksOf(
        ranked({ issue: 2, repo: api }, position(2, at(1))),
        ranked(order, { kind: 'position', position: 3, ...place }),
      );
      assert.deepStrictEqual(names(rankQueue(queue, moved)).slice(0, 4), [
        'acme/api#1',
        'acme/api#2',
        'acme/web#3',
        '#12',
      ]);
    });
  });
});

describe('the intake in rank order (ADR 0208)', () => {
  let store: EventStore;
  let log: CommandLog;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    github = fakeGitHub();
  });
  afterEach(() => store.close());

  const intake = (options: Partial<IntakeOptions> = {}) =>
    createIntake({
      log,
      brewery,
      tracker: fakeTracker(listings()),
      claims: github.host,
      claimant: alice,
      authors: ['alice'],
      repositories: [
        { repo: web, alias: 'web', filter: { labels: ['foedrum'] } },
        { repo: api, alias: 'api', filter: { labels: ['foedrum'] } },
      ],
      capacity: 2,
      clock: () => t0,
      ...options,
    });
  const accept = (command: Parameters<CommandLog['issue']>[0]): void =>
    assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
  const ordered = () => [...log.state().batches.keys()];

  it('orders the oldest issues across the Brewery and both repositories first', async () => {
    await intake().poll();
    assert.deepStrictEqual(ordered(), ['web-8', 'api-2']);
  });

  it('orders a ranked newer issue ahead of the older ones', async () => {
    accept(rank({ issue: 7, repo: web }, position(1, at(1))));
    await intake({ capacity: 1 }).poll();
    assert.deepStrictEqual(ordered(), ['web-7']);
  });

  it('orders an order marked first ahead of a ranked one, and a second mark behind the first', async () => {
    accept(rank({ issue: 7, repo: web }, position(1, at(1))));
    accept(rank({ issue: 13 }, first));
    accept(rank({ issue: 12 }, first));
    await intake({ capacity: 3 }).poll();
    assert.deepStrictEqual(ordered(), ['13-1', '12-1', 'web-7']);
  });

  it('goes on to the next order of the queue past a claim another Brewery holds, which costs no capacity', async () => {
    github.setRef(web, 8, JSON.stringify({ brewery: bob.brewery, issue: 8, claimedAt: at(0) }));
    await intake({ capacity: 1 }).poll();
    assert.deepStrictEqual(ordered(), ['api-2']);
  });

  it('skips the rest of a repository whose claim failed in this pass, and goes on with the others', async () => {
    const failing = {
      ...github.host,
      create: async (into: string, number: number, message: string) => {
        if (into === web && number === 8) throw new Error('502 Bad Gateway');
        return github.host.create(into, number, message);
      },
    };
    await intake({ claims: failing, capacity: 5 }).poll();
    assert.deepStrictEqual(ordered(), ['api-2', '12-1', '13-1']);
  });

  it('orders and claims nothing under pause --all, whatever the ranks', async () => {
    accept(rank({ issue: 12 }, first));
    accept(rank({ issue: 7, repo: web }, position(1, at(1))));
    accept({ kind: 'pause', by: 'ada', via: 'terminal' });
    await intake().poll();
    assert.deepStrictEqual(ordered(), []);
    assert.equal(github.refs.size, 0);
  });

  it('keeps the ranks through a restart: they are folded from the log', async () => {
    accept(rank({ issue: 13 }, first));
    accept(rank({ issue: 7, repo: web }, position(1, at(1))));
    log = createCommandLog({ store, recipes });
    await intake().poll();
    assert.deepStrictEqual(ordered(), ['13-1', 'web-7']);
  });

  it('claims and orders an issue once when a shifting listing returns it twice', async () => {
    // Pages of a listing shift while it is read, so one issue can come back on two of them.
    const twice = { ...listings(), [web]: [issue(8, at(1)), issue(8, at(1))], [api]: [] };
    await intake({ tracker: fakeTracker(twice), capacity: 5 }).poll();
    assert.deepStrictEqual(ordered(), ['web-8', '12-1', '13-1']);
    assert.equal(github.calls.get('create'), 1);
  });

  it('records a rank with who, from where and why, and refuses one of an order that left the queue', () => {
    const decision = log.issue({ ...rank({ issue: 12 }, first), why: 'the release' }, t0);
    assert.deepStrictEqual(decision, {
      kind: 'accepted',
      events: [ranked({ issue: 12 }, first, 'the release')],
    });
    assert.deepStrictEqual(log.state().ranks.get('#12'), {
      order: { issue: 12 },
      place: first,
      seq: 1,
      by: 'ada',
      via: 'terminal',
      why: 'the release',
    });
    accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
    assert.deepStrictEqual(log.issue(rank({ issue: 7, repo: web }, first), t0), {
      kind: 'refused',
      reason: 'acme/web#7 was ordered as batch web-7: a rank orders only the queue',
    });
  });
});

describe('foedrum rank (ADR 0208)', () => {
  let store: EventStore;
  let log: CommandLog;
  const checks = { build: null, typecheck: null, lint: null, format: null, test: null };
  const config = BreweryConfig.parse({
    brewery,
    users: ['alice'],
    repositories: {
      [web]: { checks, alias: 'web', intake: { labels: ['foedrum'] } },
      [api]: { checks, alias: 'api', intake: { labels: ['foedrum'] } },
      'acme/docs': { checks, alias: 'docs' },
    },
  });

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
  });
  afterEach(() => store.close());

  const kept = (): EventStore => ({ ...store, close: () => {} });
  const context = (overrides: Partial<CliContext> = {}): CliContext => ({
    cwd: join(sep, 'work', 'brewery'),
    gatherDoctorFacts: async () => linux(),
    openStore: () => kept(),
    openWritableStore: () => kept(),
    recipes: () => recipes,
    brewers: () => assert.fail('no brewer files to read'),
    user: () => 'ada',
    surface: 'terminal',
    now: () => t0,
    zone: () => 'UTC',
    readKeptBranches: async () => assert.fail('no kept branch to read'),
    config: () => config,
    claims: () => assert.fail('rank claims nothing'),
    queue: (given) => {
      assert.equal(given, config);
      return { tracker: fakeTracker(listings()), login: async () => 'alice' };
    },
    serve: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    brew: async () => assert.fail('no brew here'),
    watch: async () => assert.fail('no watch here'),
    resume: async () => assert.fail('no session to resume'),
    init: async () => assert.fail('no init here'),
    env: {},
    ...overrides,
  });
  const run = (argv: string[], overrides: Partial<CliContext> = {}): Promise<CliResult> =>
    runCli(argv, context(overrides));
  const ok = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: '' });
  const refused = (reason: string): CliResult => ({
    exitCode: 1,
    stdout: '',
    stderr: `foedrum rank: ${reason}\n`,
  });
  const last = (): Event | undefined => store.eventsAfter(0).at(-1)?.event;
  const lastId = () => store.lastEventId();

  it('moves an order to a place, kept as the arrival of the order that was there, with who and why', async () => {
    assert.deepStrictEqual(
      await run(['rank', 'web#7', '1', '--why', 'the release']),
      ok('web#7 ranked 1: place 1 of 5 in the queue\n'),
    );
    assert.deepStrictEqual(
      last(),
      ranked({ issue: 7, repo: web }, position(1, at(1)), 'the release'),
    );
  });

  it('marks an order to finish first, from the plugin too', async () => {
    assert.deepStrictEqual(
      await run(['rank', '#12', 'first'], { surface: 'plugin' }),
      ok('#12 marked to finish first: place 1 of 5 in the queue\n'),
    );
    assert.deepStrictEqual(last(), { ...ranked({ issue: 12 }, first), via: 'plugin' });
  });

  it('places an order past the end of the queue at the time of the rank', async () => {
    assert.deepStrictEqual(
      await run(['rank', 'api#2', '9']),
      ok('api#2 ranked 9: place 5 of 5 in the queue\n'),
    );
    assert.deepStrictEqual(last(), ranked({ issue: 2, repo: api }, position(9, t0.toISOString())));
  });

  it('keeps the place asked for when the order ahead of it was ranked to the same arrival', async () => {
    // #13 goes to place 2, at api#2's arrival; web#7 then goes to place 3, between the two.
    assert.deepStrictEqual(
      await run(['rank', '#13', '2']),
      ok('#13 ranked 2: place 2 of 5 in the queue\n'),
    );
    assert.deepStrictEqual(
      await run(['rank', 'web#7', '3']),
      ok('web#7 ranked 3: place 3 of 5 in the queue\n'),
    );
    assert.deepStrictEqual(last(), ranked({ issue: 7, repo: web }, position(3, at(2), 1)));
  });

  it("prints an order's place in the queue and its rank, and appends nothing", async () => {
    await run(['rank', 'web#7', '1', '--why', 'the release']);
    await run(['rank', '12', 'first']);
    const before = lastId();
    assert.deepStrictEqual(
      await run(['rank', 'web#7']),
      ok('web#7: place 2 of 5 in the queue, ranked 1 by ada via terminal: the release\n'),
    );
    assert.deepStrictEqual(
      await run(['rank', '#12']),
      ok('#12: place 1 of 5 in the queue, marked to finish first by ada via terminal\n'),
    );
    assert.deepStrictEqual(
      await run(['rank', 'api#2']),
      ok('api#2: place 4 of 5 in the queue, by its arrival\n'),
    );
    assert.equal(lastId(), before);
  });

  it('refuses with one line an alias foedrum.jsonc lacks, and an issue not in the queue', async () => {
    const before = lastId();
    assert.deepStrictEqual(
      await run(['rank', 'nope#7', '1']),
      refused('foedrum.jsonc names no repository with the alias nope'),
    );
    const closed = (): CliContext['queue'] => () => ({
      tracker: fakeTracker({ ...listings(), [web]: [issue(9, at(0), { state: 'closed' })] }),
      login: async () => 'alice',
    });
    for (const target of ['web#9', 'docs#1', '#40']) {
      assert.deepStrictEqual(
        await run(['rank', target, '1'], { queue: closed() }),
        refused(
          `${target} is not in the intake's queue: closed, filtered out, assigned to someone else or not opened by an allow-listed user`,
        ),
        target,
      );
    }
    assert.equal(lastId(), before);
  });

  it('refuses an order that has a batch, a sub-order, and the Brewery issue of a claimed issue', async () => {
    const accept = (command: Parameters<CommandLog['issue']>[0]): void =>
      assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
    accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
    accept({
      kind: 'record',
      event: { type: 'effect.applied', key: '["web-7","order.issue"]', result: 12 },
    });
    accept({ kind: 'order', batchId: '30-1', order: { issue: 30 } });
    accept({ kind: 'route', batchId: '30-1', recipe: 'half', reason: 'label', source: 'label' });
    accept({
      kind: 'record',
      event: {
        type: 'order.decomposed',
        batchId: '30-1',
        subOrders: [{ issue: 31, repo: web }],
        dependencies: [],
      },
    });
    const before = lastId();
    assert.deepStrictEqual(
      await run(['rank', 'web#7', '1']),
      refused('acme/web#7 was ordered as batch web-7: a rank orders only the queue'),
    );
    assert.deepStrictEqual(
      await run(['rank', '#31', 'first']),
      refused('#31 is a sub-order of #30; its plan ranks it'),
    );
    assert.deepStrictEqual(
      await run(['rank', '#12', 'first']),
      refused('#12 is the order of web#7; rank web#7'),
    );
    assert.equal(lastId(), before);
  });

  it('refuses when the queue cannot be read, or the Brewery is not named', async () => {
    const down: CliContext['queue'] = () => ({
      tracker: fakeTracker({ [brewery]: [], [web]: [] }),
      login: async () => 'alice',
    });
    assert.deepStrictEqual(
      await run(['rank', 'web#7', '1'], { queue: down }),
      refused("cannot read the intake's queue: listing acme/api: 502 listing acme/api"),
    );
    const { brewery: _, ...unnamed } = config;
    const result = await run(['rank', 'web#7', '1'], { config: () => unnamed });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum rank: .*"brewery"/);
  });

  it('refuses --why without a place', async () => {
    const result = await run(['rank', 'web#7', '--why', 'soon']);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /^foedrum rank: invalid </);
  });

  it("replays the ranks of a batch's order beside its own events", async () => {
    await run(['rank', 'web#7', '1', '--why', 'the release']);
    await run(['rank', 'api#2', 'first']);
    assert.equal(
      log.issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } }, t0).kind,
      'accepted',
    );
    const replay = (await run(['replay', 'web-7'])).stdout;
    assert.match(
      replay,
      /order\.ranked +\{"order":\{"issue":7,"repo":"acme\/web"\},"place":\{"kind":"position","position":1,"arrival":"2026-10-20T10:01:00\.000Z","tie":0\},"by":"ada","via":"terminal","why":"the release"\}/,
    );
    assert.doesNotMatch(replay, /"repo":"acme\/api"/);
  });
});
