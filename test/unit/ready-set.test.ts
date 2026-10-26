// The ready set (ADR 0211): the intake starts the sub-orders whose blockers' pull requests merged,
// at their order's rank and in their plan's order. Recorded `order.decomposed` events and a fake
// tracker, no network (ADR 0021): nothing produces sub-orders until mash (#388, #389).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import {
  createIntake,
  type IntakeNotice,
  type IntakeOptions,
  type TargetTracker,
} from '../../src/engine/intake.ts';
import type { PullRequestState, TargetIssue } from '../../src/engine/issue-claims.ts';
import { readySubOrders } from '../../src/engine/ready-set.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const web = 'acme/web';
const now = new Date('2026-10-26T12:00:00.000Z');
const routeBy = '2026-10-26T13:00:00.000Z';
/** `minutes` after 10:00 on the day of `now`. */
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 26, 10, minutes)).toISOString();
const pr = (n: number): string => `https://github.com/acme/web/pull/${n}`;
const recipes = fakeRecipes({ half: fakeRecipe({ steps: ['plan'] }) });

const ordered = (batchId: string, issue: number, parentBatchId?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue },
  ...(parentBatchId === undefined ? {} : { parentBatchId }),
  routeBy,
});
/** `blocks`: [sub-order, blocked by, kind], `code` by default. */
const decomposed = (
  batchId: string,
  subOrders: readonly number[],
  blocks: readonly [number, number, ('code' | 'release')?][] = [],
): Event => ({
  type: 'order.decomposed',
  batchId,
  subOrders: subOrders.map((issue) => ({ issue, repo: web })),
  dependencies: blocks.map(([subOrder, blockedBy, kind = 'code']) => ({
    subOrder,
    blockedBy,
    kind,
  })),
});
const onTap = (batchId: string, ...pullRequests: string[]): Event => ({
  type: 'batch.on_tap',
  batchId,
  pullRequests,
});
const ended = (batchId: string, pullRequest: string, state: 'merged' | 'closed'): Event => ({
  type: 'pull_request.ended',
  batchId,
  pullRequest,
  state,
});

/** An order whose batch decomposed it and waits On tap, so it holds no slot. */
const started = (
  order: number,
  subOrders: readonly number[],
  blocks: readonly [number, number, ('code' | 'release')?][] = [],
): Event[] => [
  ordered(`${order}-1`, order),
  decomposed(`${order}-1`, subOrders, blocks),
  onTap(`${order}-1`),
];

const ready = (...events: Event[]) => readySubOrders(fold(events));
const sub = (order: number, issue: number, parentBatchId = `${order}-1`) => ({
  order,
  issue,
  parentBatchId,
});

describe('readySubOrders', () => {
  it('is empty while no order was decomposed', () => {
    assert.deepStrictEqual(ready(ordered('1-1', 1)), []);
  });

  it("holds a sub-order with no blocker, under its order's latest batch", () => {
    assert.deepStrictEqual(ready(ordered('1-1', 1), decomposed('1-1', [2, 3], [[3, 2]])), [
      sub(1, 2),
    ]);
    assert.deepStrictEqual(ready(ordered('1-1', 1), ordered('1-2', 1), decomposed('1-2', [2])), [
      sub(1, 2, '1-2'),
    ]);
  });

  it('holds a blocked sub-order only once a pull request of its blocker merged', () => {
    const start = [
      ordered('1-1', 1),
      decomposed('1-1', [2, 3], [[3, 2]]),
      ordered('2-1', 2, '1-1'),
    ];
    // Brewing, On tap with its pull request open, and closed: not done.
    assert.deepStrictEqual(ready(...start), []);
    assert.deepStrictEqual(ready(...start, onTap('2-1', pr(5))), []);
    assert.deepStrictEqual(ready(...start, onTap('2-1', pr(5)), ended('2-1', pr(5), 'closed')), []);
    assert.deepStrictEqual(ready(...start, onTap('2-1', pr(5)), ended('2-1', pr(5), 'merged')), [
      sub(1, 3),
    ]);
  });

  it('holds a sub-order whose blocker is in a bottle whose pull request merged', () => {
    const events = [
      ordered('1-1', 1),
      decomposed('1-1', [2, 3, 4], [[4, 2]]),
      ordered('2-1', 2, '1-1'),
      ordered('3-1', 3, '1-1'),
      { type: 'bottle.opened', bottleId: 'b1', repo: web, subOrders: [2, 3], pullRequest: pr(9) },
      onTap('3-1', pr(9)),
    ] as const satisfies Event[];
    assert.deepStrictEqual(ready(...events), []);
    // Recorded on the batch of the other sub-order of the bottle.
    assert.deepStrictEqual(ready(...events, ended('3-1', pr(9), 'merged')), [sub(1, 4)]);
  });

  it('never holds a sub-order whose blocker is not in the bottle that merged', () => {
    assert.deepStrictEqual(
      ready(
        ordered('1-1', 1),
        decomposed('1-1', [2, 3, 4], [[4, 2]]),
        ordered('2-1', 2, '1-1'),
        ordered('3-1', 3, '1-1'),
        { type: 'bottle.opened', bottleId: 'b1', repo: web, subOrders: [3], pullRequest: pr(9) },
        onTap('3-1', pr(9)),
        ended('3-1', pr(9), 'merged'),
      ),
      [],
    );
  });

  it('never holds a sub-order blocked by a release, merged or not: #538 adds the release signal', () => {
    assert.deepStrictEqual(
      ready(
        ordered('1-1', 1),
        decomposed('1-1', [2, 3], [[3, 2, 'release']]),
        ordered('2-1', 2, '1-1'),
        onTap('2-1', pr(5)),
        ended('2-1', pr(5), 'merged'),
      ),
      [],
    );
  });

  it("goes by order number, each order's sub-orders in its plan's order", () => {
    assert.deepStrictEqual(
      ready(
        ordered('10-1', 10),
        decomposed('10-1', [12, 11]),
        ordered('1-1', 1),
        decomposed('1-1', [4, 2, 3]),
      ),
      [sub(1, 4), sub(1, 2), sub(1, 3), sub(10, 12, '10-1'), sub(10, 11, '10-1')],
    );
  });

  it('leaves out a sub-order with a batch, and one a later breakdown cancelled', () => {
    assert.deepStrictEqual(
      ready(
        ordered('1-1', 1),
        decomposed('1-1', [2, 3, 4]),
        ordered('2-1', 2, '1-1'),
        decomposed('1-1', [2, 4]),
      ),
      [sub(1, 4)],
    );
  });

  it('leaves out the sub-orders of a paused order, and of an order whose latest batch was cancelled', () => {
    const base = [
      ordered('1-1', 1),
      decomposed('1-1', [2]),
      ordered('5-1', 5),
      decomposed('5-1', [6]),
    ];
    const paused: Event = { type: 'order.paused', order: { issue: 1 }, by: 'ada', via: 'terminal' };
    assert.deepStrictEqual(ready(...base, paused), [sub(5, 6)]);
    const cancelled: Event = {
      type: 'batch.cancelled',
      batchId: '5-1',
      by: 'ada',
      via: 'terminal',
    };
    assert.deepStrictEqual(ready(...base, cancelled), [sub(1, 2)]);
  });

  it('leaves out the sub-orders of an order stopped while a batch of it is still Stuck (ADR 0205)', () => {
    const stuck = (batchId: string, kind: 'stopped' | 'routing'): Event => ({
      type: 'batch.stuck',
      batchId,
      reason:
        kind === 'stopped'
          ? { kind, stepId: 'plan', by: 'ada', via: 'terminal' }
          : { kind, deadlineAt: routeBy },
      options: ['retry'],
      remindAt: routeBy,
    });
    const base = [
      ordered('1-1', 1),
      decomposed('1-1', [2, 3]),
      ordered('2-1', 2, '1-1'),
      ordered('5-1', 5),
      decomposed('5-1', [6]),
    ];
    // A sub-order's batch stopped holds its order; Stuck for another reason does not.
    assert.deepStrictEqual(ready(...base, stuck('2-1', 'stopped')), [sub(5, 6)]);
    assert.deepStrictEqual(ready(...base, stuck('2-1', 'routing')), [sub(1, 3), sub(5, 6)]);
    // The order's own batch stopped holds it too, until a retry moves it on.
    assert.deepStrictEqual(ready(...base, stuck('5-1', 'stopped')), [sub(1, 3)]);
    assert.deepStrictEqual(
      ready(...base, stuck('5-1', 'stopped'), {
        type: 'step.scheduled',
        batchId: '5-1',
        stepId: 'plan',
        attempt: 1,
        deadlineAt: routeBy,
        retry: true,
      }),
      [sub(1, 3), sub(5, 6)],
    );
  });
});

describe('the intake starts ready sub-orders (ADR 0211)', () => {
  let store: EventStore;
  let log: CommandLog;
  let notices: IntakeNotice[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    notices = [];
  });
  afterEach(() => store.close());

  /** The log of `events`, as a driver would have recorded them. */
  const recorded = (...events: Event[]): void => {
    store.withTransaction((tx) => {
      for (const event of events) tx.append(event);
    });
    log = createCommandLog({ store, recipes });
  };
  const issue = (number: number, created: string, fields: Partial<TargetIssue> = {}) => ({
    number,
    state: 'open' as const,
    pullRequest: false,
    labels: ['recipe:half'],
    milestone: undefined,
    assignees: [],
    author: 'alice',
    created,
    ...fields,
  });
  const tracker = (
    listed: readonly TargetIssue[],
    pullRequests: Record<string, PullRequestState> = {},
  ): TargetTracker => ({
    issues: async (repo) => (repo === brewery ? listed : []),
    pullRequest: async (url) => pullRequests[url] ?? 'open',
  });
  const poll = (listed: TargetTracker, options: Partial<IntakeOptions> = {}) =>
    createIntake({
      log,
      brewery,
      tracker: listed,
      claims: fakeGitHub().host,
      claimant: { brewery, login: 'alice' },
      authors: ['alice'],
      repositories: [],
      capacity: 5,
      clock: () => now,
      report: (notice) => notices.push(notice),
      ...options,
    }).poll();
  const newBatches = (before: readonly string[]) =>
    [...log.state().batches.values()]
      .filter(({ id }) => !before.includes(id))
      .map(({ id, parentBatchId }) => `${id} under ${parentBatchId ?? 'none'}`);

  it("orders a sub-order with no blocker under its order's batch, and routes it by its label", async () => {
    recorded(...started(1, [2, 3], [[3, 2]]));
    await poll(tracker([issue(1, at(0)), issue(2, at(1)), issue(3, at(2))]));
    assert.deepStrictEqual(newBatches(['1-1']), ['2-1 under 1-1']);
    assert.equal(log.state().batches.get('2-1')?.recipe?.name, 'half');
    assert.deepStrictEqual(
      notices.filter(({ kind }) => kind === 'ordered'),
      [{ kind: 'ordered', repo: brewery, issue: 2, batchId: '2-1' }],
    );
  });

  it("orders a blocked sub-order in the first pass after its blocker's merge is recorded", async () => {
    recorded(...started(1, [2, 3], [[3, 2]]), ordered('2-1', 2, '1-1'), onTap('2-1', pr(5)));
    const listed = [issue(1, at(0)), issue(2, at(1)), issue(3, at(2))];
    const pullRequests: Record<string, PullRequestState> = { [pr(5)]: 'open' };
    await poll(tracker(listed, pullRequests));
    assert.deepStrictEqual(newBatches(['1-1', '2-1']), []);
    pullRequests[pr(5)] = 'merged';
    await poll(tracker(listed, pullRequests));
    assert.deepStrictEqual(newBatches(['1-1', '2-1']), ['3-1 under 1-1']);
  });

  it('never orders a sub-order whose blocker closed its pull request, or is only On tap', async () => {
    recorded(
      ...started(
        1,
        [2, 3, 4, 5],
        [
          [3, 2],
          [5, 4],
        ],
      ),
      ordered('2-1', 2, '1-1'),
      onTap('2-1', pr(5)),
      ordered('4-1', 4, '1-1'),
      onTap('4-1', pr(6)),
    );
    const listed = [1, 2, 3, 4, 5].map((n) => issue(n, at(n)));
    await poll(tracker(listed, { [pr(5)]: 'closed', [pr(6)]: 'open' }));
    assert.deepStrictEqual(newBatches(['1-1', '2-1', '4-1']), []);
  });

  it('orders the ready sub-orders of two orders in rank order, and of one order in its plan order', async () => {
    recorded(...started(1, [3, 2]), ...started(10, [11]));
    const listed = [
      issue(10, at(0)),
      issue(1, at(5)),
      issue(2, at(6)),
      issue(3, at(7)),
      issue(11, at(8)),
    ];
    await poll(tracker(listed), { capacity: 2 });
    // #10 arrived first: its sub-order goes first, then #1's first in its plan.
    assert.deepStrictEqual(newBatches(['1-1', '10-1']), ['11-1 under 10-1', '3-1 under 1-1']);
  });

  it('orders the sub-orders of an order ranked first ahead of an older order', async () => {
    recorded(...started(1, [2]), ...started(10, [11]), {
      type: 'order.ranked',
      order: { issue: 1 },
      place: { kind: 'first' },
      by: 'ada',
      via: 'terminal',
    });
    const listed = [issue(10, at(0)), issue(1, at(5)), issue(2, at(6)), issue(11, at(8))];
    await poll(tracker(listed), { capacity: 1 });
    assert.deepStrictEqual(newBatches(['1-1', '10-1']), ['2-1 under 1-1']);
  });

  it("puts a started order's next sub-order ahead of a new order of the same place, and behind a higher-ranked one", async () => {
    recorded(...started(5, [6]));
    // #1 is new and arrived in the same second as #5; a number would put it first.
    await poll(tracker([issue(1, at(3)), issue(5, at(3)), issue(6, at(4))]), { capacity: 1 });
    assert.deepStrictEqual(newBatches(['5-1']), ['6-1 under 5-1']);

    store.close();
    store = openSqliteEventStore(':memory:');
    recorded(...started(5, [6]));
    await poll(tracker([issue(1, at(2)), issue(5, at(3)), issue(6, at(4))]), { capacity: 1 });
    assert.deepStrictEqual(newBatches(['5-1']), ['1-1 under none']);
  });

  it('never orders a sub-order whose issue is closed or unlisted, nor one of an order the pass did not list', async () => {
    recorded(...started(1, [2, 3]), ...started(10, [11]));
    await poll(tracker([issue(1, at(0)), issue(2, at(1), { state: 'closed' }), issue(11, at(3))]));
    assert.deepStrictEqual(newBatches(['1-1', '10-1']), []);
  });

  it('never orders the sub-orders of a paused order, nor any under pause --all', async () => {
    recorded(...started(1, [2]), ...started(10, [11]), {
      type: 'order.paused',
      order: { issue: 1 },
      by: 'ada',
      via: 'terminal',
    });
    const listed = [issue(1, at(0)), issue(2, at(1)), issue(10, at(2)), issue(11, at(3))];
    await poll(tracker(listed));
    assert.deepStrictEqual(newBatches(['1-1', '10-1']), ['11-1 under 10-1']);

    store.close();
    store = openSqliteEventStore(':memory:');
    recorded(...started(1, [2]), { type: 'order.paused', by: 'ada', via: 'terminal' });
    await poll(tracker(listed));
    assert.deepStrictEqual(newBatches(['1-1']), []);
  });

  it('never orders a sub-order that a later breakdown cancelled', async () => {
    recorded(...started(1, [2, 3]), decomposed('1-1', [3]));
    await poll(tracker([issue(1, at(0)), issue(2, at(1)), issue(3, at(2))]));
    assert.deepStrictEqual(newBatches(['1-1']), ['3-1 under 1-1']);
  });
});
