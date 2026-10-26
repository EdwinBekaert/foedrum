// The limits on what the intake starts (ADR 0217): a recipe's `concurrency` and the open-order
// limit. Recorded events and a fake listing, no network (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { formatStatus } from '../../src/cli/status.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import {
  createIntake,
  type IntakeNotice,
  type IntakeOptions,
  type TargetTracker,
} from '../../src/engine/intake.ts';
import type { Claimant, TargetIssue } from '../../src/engine/issue-claims.ts';
import { type Limits, limitLines, limitsOf, mayHold, openOrders } from '../../src/engine/limits.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type FakeGitHub, fakeGitHub } from '../helpers/fake-github.ts';
import { createdOf } from '../helpers/fake-github-api.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const web = 'acme/web';
const now = new Date('2026-10-26T09:00:00.000Z');
const alice: Claimant = { brewery, login: 'alice' };
const recipes = fakeRecipes({
  nip: { ...fakeRecipe({ steps: ['plan'] }), concurrency: 1 },
  half: fakeRecipe({ steps: ['plan'] }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const unlimited: Limits = { openOrders: 20, recipe: (name) => recipes.find(name)?.concurrency };

const issue = (number: number, labels: readonly string[]): TargetIssue => ({
  number,
  state: 'open',
  pullRequest: false,
  labels,
  milestone: undefined,
  assignees: [],
  author: 'alice',
  created: createdOf(number),
});

const fakeTracker = (issues: Record<string, TargetIssue[]>): TargetTracker => ({
  issues: async (repo) => issues[repo] ?? [],
  pullRequest: async () => 'open',
});

describe('the limits of a pass (ADR 0217)', () => {
  let store: EventStore;
  let log: CommandLog;
  let github: FakeGitHub;
  let notices: IntakeNotice[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    github = fakeGitHub();
    notices = [];
  });
  afterEach(() => store.close());

  const intake = (issues: Record<string, TargetIssue[]>, options: Partial<IntakeOptions> = {}) =>
    createIntake({
      log,
      brewery,
      tracker: fakeTracker(issues),
      claims: github.host,
      claimant: alice,
      authors: ['alice'],
      repositories: [{ repo: web, alias: 'web', filter: { labels: ['foedrum'] } }],
      capacity: 5,
      limits: unlimited,
      clock: () => now,
      report: (notice) => notices.push(notice),
      ...options,
    });
  const accept = (command: Parameters<CommandLog['issue']>[0], at = now): void => {
    const decision = log.issue(command, at);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  /** Orders the Brewery issue `number` and routes it to `recipe`: it brews. */
  const brewing = (number: number, recipe: string): void => {
    const batchId = `${number}-1`;
    accept({ kind: 'order', batchId, order: { issue: number } });
    accept({
      kind: 'route',
      batchId,
      recipe,
      reason: `the label recipe:${recipe}`,
      source: 'label',
    });
  };
  /** Runs the one step of a brewing batch to its end: it goes on tap. */
  const onTap = (batchId: string): void => {
    accept({
      kind: 'record',
      event: { type: 'step.started', batchId, stepId: 'plan', attempt: 1 },
    });
    accept({ kind: 'finish', batchId, stepId: 'plan', attempt: 1, ending: succeeded });
  };
  const lanes = () =>
    [...log.state().batches.values()].map(({ id, lane, recipe }) =>
      [id, lane.kind, recipe?.name].filter((part) => part !== undefined).join(' '),
    );
  const held = () => notices.filter((notice) => notice.kind === 'held');

  describe("a recipe's concurrency", () => {
    it('holds a second order of a recipe at its limit, and a later order of another recipe takes the slot', async () => {
      brewing(12, 'nip');
      const listed = {
        [brewery]: [
          issue(12, ['recipe:nip']),
          issue(13, ['recipe:nip']),
          issue(14, ['recipe:half']),
        ],
      };
      const pass = intake(listed);
      await pass.poll();
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing nip', '14-1 brewing half']);
      assert.deepStrictEqual(held(), [
        {
          kind: 'held',
          repo: brewery,
          issue: 13,
          reason: 'recipe nip brews its 1 at once (concurrency)',
        },
      ]);
    });

    it('orders the held issue at the next pass once the batch that held it is on tap', async () => {
      brewing(12, 'nip');
      const listed = { [brewery]: [issue(12, ['recipe:nip']), issue(13, ['recipe:nip'])] };
      const pass = intake(listed);
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing nip']);
      onTap('12-1');
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['12-1 on_tap nip', '13-1 brewing nip']);
    });

    it('orders no more of a recipe than its limit in one pass, counting what it ordered before', async () => {
      const listed = { [brewery]: [issue(12, ['recipe:nip']), issue(13, ['recipe:nip'])] };
      await intake(listed).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing nip']);
    });

    it('counts an Ordered batch the pass will route to the recipe', async () => {
      // A retry or a pass killed before it routed: 12-1 is Ordered, and its label says nip.
      accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
      const listed = { [brewery]: [issue(12, ['recipe:nip']), issue(13, ['recipe:nip'])] };
      await intake(listed).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing nip']);
    });

    it('does not route a claimed batch to a recipe at its limit, says so once, and it goes Stuck on routing at its deadline', async () => {
      brewing(12, 'nip');
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      // The driver opened Brewery issue #20 as web-7's order (ADR 0144).
      accept({
        kind: 'record',
        event: { type: 'effect.applied', key: '["web-7","order.issue"]', result: 20 },
      });
      const before = log.state().batches.get('web-7')?.lane;
      const listed = {
        [brewery]: [issue(12, ['recipe:nip']), issue(20, ['recipe:nip'])],
        [web]: [],
      };
      const pass = intake(listed);
      await pass.poll();
      await pass.poll();
      assert.deepStrictEqual(log.state().batches.get('web-7')?.lane, before);
      assert.deepStrictEqual(
        notices.filter((notice) => notice.kind === 'unrouted'),
        [
          {
            kind: 'unrouted',
            batchId: 'web-7',
            reason: 'recipe nip brews its 1 at once (concurrency)',
          },
        ],
      );
      const routeBy = before?.kind === 'ordered' ? new Date(before.routeBy) : now;
      accept({ kind: 'unrouted', batchId: 'web-7' }, routeBy);
      assert.equal(log.state().batches.get('web-7')?.lane.kind, 'stuck');
    });

    it('routes the claimed batch at the next pass once the recipe has a free place', async () => {
      brewing(12, 'nip');
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      accept({
        kind: 'record',
        event: { type: 'effect.applied', key: '["web-7","order.issue"]', result: 20 },
      });
      const listed = { [brewery]: [issue(20, ['recipe:nip'])], [web]: [] };
      const pass = intake(listed);
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing nip', 'web-7 ordered']);
      onTap('12-1');
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['12-1 on_tap nip', 'web-7 brewing nip']);
    });

    it("never holds a person's recipe for a Stuck batch: they mean it now", async () => {
      brewing(12, 'nip');
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      accept({ kind: 'unrouted', batchId: 'web-7' }, new Date('2026-10-26T10:00:00.000Z'));
      accept({
        kind: 'recipe',
        batchId: 'web-7',
        recipe: 'nip',
        reason: 'needed today',
        by: 'alice',
        via: 'terminal',
      });
      await intake({ [brewery]: [issue(12, ['recipe:nip'])], [web]: [] }).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing nip', 'web-7 brewing nip']);
    });

    it('holds a ready sub-order of a recipe at its limit', async () => {
      brewing(12, 'nip');
      brewing(1, 'half');
      accept({
        kind: 'record',
        event: {
          type: 'order.decomposed',
          batchId: '1-1',
          subOrders: [{ issue: 10, repo: web }],
          dependencies: [],
        },
      });
      const listed = { [brewery]: [issue(1, ['recipe:half']), issue(10, ['recipe:nip'])] };
      await intake(listed).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing nip', '1-1 brewing half']);
      // The notice names the sub-order, not its order.
      assert.deepStrictEqual(held(), [
        {
          kind: 'held',
          repo: brewery,
          issue: 10,
          reason: 'recipe nip brews its 1 at once (concurrency)',
        },
      ]);
    });

    it('routes one of two Ordered batches of a recipe at its limit in one pass, and holds the other', async () => {
      for (const [batchId, number, order] of [
        ['web-7', 7, 20],
        ['web-8', 8, 21],
      ] as const) {
        accept({ kind: 'order', batchId, order: { issue: number, repo: web } });
        accept({
          kind: 'record',
          event: { type: 'effect.applied', key: `["${batchId}","order.issue"]`, result: order },
        });
      }
      const listed = {
        [brewery]: [issue(20, ['recipe:nip']), issue(21, ['recipe:nip'])],
        [web]: [],
      };
      await intake(listed).poll();
      assert.deepStrictEqual(lanes(), ['web-7 brewing nip', 'web-8 ordered']);
      assert.deepStrictEqual(
        notices.filter((notice) => notice.kind === 'unrouted'),
        [
          {
            kind: 'unrouted',
            batchId: 'web-8',
            reason: 'recipe nip brews its 1 at once (concurrency)',
          },
        ],
      );
    });
  });

  describe('the open-order limit', () => {
    it('orders no fourth new order and claims no target issue, while a ready sub-order of an open order starts', async () => {
      brewing(1, 'half');
      brewing(2, 'half');
      brewing(3, 'half');
      accept({
        kind: 'record',
        event: {
          type: 'order.decomposed',
          batchId: '1-1',
          subOrders: [{ issue: 10, repo: web }],
          dependencies: [],
        },
      });
      const listed = {
        [brewery]: [
          issue(1, ['recipe:half']),
          issue(4, ['recipe:half']),
          issue(10, ['recipe:half']),
        ],
        [web]: [issue(7, ['foedrum'])],
      };
      const pass = intake(listed, { limits: { ...unlimited, openOrders: 3 } });
      await pass.poll();
      await pass.poll();
      assert.deepStrictEqual(lanes(), [
        '1-1 brewing half',
        '2-1 brewing half',
        '3-1 brewing half',
        '10-1 brewing half',
      ]);
      assert.equal(github.refs.size, 0);
      assert.deepStrictEqual(held(), [
        {
          kind: 'held',
          repo: brewery,
          issue: 4,
          reason: "3 orders are open, the Brewery's openOrders",
        },
        {
          kind: 'held',
          repo: web,
          issue: 7,
          reason: "3 orders are open, the Brewery's openOrders",
        },
      ]);
    });

    it('counts the new orders of the same pass', async () => {
      const listed = {
        [brewery]: [
          issue(1, ['recipe:half']),
          issue(2, ['recipe:half']),
          issue(3, ['recipe:half']),
        ],
      };
      await intake(listed, { limits: { ...unlimited, openOrders: 2 } }).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing half', '2-1 brewing half']);
    });

    it('counts a target issue it claimed as a new order of the same pass', async () => {
      const listed = { [web]: [issue(7, ['foedrum']), issue(8, ['foedrum'])] };
      await intake(listed, { limits: { ...unlimited, openOrders: 1 } }).poll();
      assert.deepStrictEqual(lanes(), ['web-7 ordered']);
      assert.deepStrictEqual([...github.refs.keys()], [`${web}#7`]);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: web, issue: 8, reason: "1 order is open, the Brewery's openOrders" },
      ]);
    });
  });

  describe('what an open order is (decided 2026-10-26)', () => {
    const decompose = (batchId: string, issues: readonly number[]): void =>
      accept({
        kind: 'record',
        event: {
          type: 'order.decomposed',
          batchId,
          subOrders: issues.map((n) => ({ issue: n, repo: web })),
          dependencies: [],
        },
      });
    const open = () => [...openOrders(log.state()).keys()];

    it('counts an order with a batch Ordered or Brewing', () => {
      accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
      brewing(2, 'half');
      assert.deepStrictEqual(open(), ['#1', '#2']);
    });

    it('counts an order with a batch Conditioning', () => {
      accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
      accept({ kind: 'order', batchId: '2-1', order: { issue: 2 } });
      accept({ kind: 'wait', batchId: '1-1', on: { kind: 'sibling', batchId: '2-1' } });
      accept({ kind: 'cancel', batchId: '2-1', by: 'alice', via: 'terminal' });
      assert.equal(log.state().batches.get('1-1')?.lane.kind, 'conditioning');
      assert.deepStrictEqual(open(), ['#1']);
      assert.equal(mayHold(log.state()), true);
    });

    it('counts a paused order, a stopped one and a Stuck one', () => {
      brewing(1, 'half');
      accept({ kind: 'pause', order: { issue: 1 }, by: 'alice', via: 'terminal' });
      brewing(2, 'half');
      accept({
        kind: 'record',
        event: { type: 'step.started', batchId: '2-1', stepId: 'plan', attempt: 1 },
      });
      accept({ kind: 'stop', order: { issue: 2 }, by: 'alice', via: 'terminal' });
      accept({ kind: 'order', batchId: '3-1', order: { issue: 3 } });
      accept({ kind: 'unrouted', batchId: '3-1' }, new Date('2026-10-26T10:00:00.000Z'));
      assert.deepStrictEqual(
        [...log.state().batches.values()].map(({ lane }) => lane.kind),
        ['brewing', 'stuck', 'stuck'],
      );
      assert.deepStrictEqual(open(), ['#1', '#2', '#3']);
    });

    it('does not count an order on tap with its pull request open, nor a cancelled one', () => {
      brewing(1, 'half');
      onTap('1-1');
      accept({ kind: 'order', batchId: '2-1', order: { issue: 2 } });
      accept({ kind: 'cancel', batchId: '2-1', by: 'alice', via: 'terminal' });
      assert.deepStrictEqual(open(), []);
    });

    it('counts a decomposed order on tap while a sub-order of its latest breakdown has no batch', () => {
      brewing(1, 'half');
      decompose('1-1', [10, 11]);
      onTap('1-1');
      assert.deepStrictEqual(open(), ['#1']);
    });

    it('lets status read the limits while only such an order is open, with no batch live (review of #563)', () => {
      brewing(1, 'half');
      decompose('1-1', [10]);
      onTap('1-1');
      assert.equal(mayHold(log.state()), true);
      assert.deepStrictEqual(limitLines(log.state(), { ...unlimited, openOrders: 1 }), [
        'open orders: 1 of 1 (#1); new orders wait',
      ]);
    });

    it('lets status skip the limits while no order is open', () => {
      brewing(1, 'half');
      onTap('1-1');
      assert.equal(mayHold(log.state()), false);
    });

    it("counts a sub-order's batch as its order's, and a claimed batch by its target issue", () => {
      brewing(1, 'half');
      decompose('1-1', [10]);
      onTap('1-1');
      accept({ kind: 'order', batchId: '10-1', order: { issue: 10 }, parentBatchId: '1-1' });
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      assert.deepStrictEqual(open(), ['#1', `${web}#7`]);
    });

    it('does not count a cancelled order with sub-orders left', () => {
      accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
      decompose('1-1', [10]);
      accept({ kind: 'cancel', batchId: '1-1', by: 'alice', via: 'terminal' });
      assert.deepStrictEqual(open(), []);
    });
  });

  describe('foedrum status (the issue\'s "See it")', () => {
    // Made in each test: a throw at the describe would fail the whole suite before it runs.
    const limitsNow = () => limitsOf(3, recipes);

    it('says why a second order of a recipe at its concurrency of 1 waits', async () => {
      brewing(12, 'nip');
      const listed = { [brewery]: [issue(12, ['recipe:nip']), issue(13, ['recipe:nip'])] };
      await intake(listed, { limits: limitsNow() }).poll();
      const state = log.state();
      const lines = limitLines(state, limitsNow());
      assert.deepStrictEqual(lines, ['recipe nip: 1 of 1 at once (12-1); its next orders wait']);
      assert.match(
        formatStatus(state, [], new Map(), lines),
        /^recipe nip: 1 of 1 at once \(12-1\); its next orders wait\n\n1 batch\n/,
      );
    });

    it('names the open orders once the open-order limit is reached, by their status names', () => {
      brewing(1, 'half');
      brewing(2, 'half');
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      accept({
        kind: 'record',
        event: { type: 'effect.applied', key: '["web-7","order.issue"]', result: 20 },
      });
      assert.deepStrictEqual(limitLines(log.state(), limitsNow()), [
        'open orders: 3 of 3 (#1, #2, #20 (web#7)); new orders wait',
      ]);
    });

    it('prints nothing while no limit holds, and the board as before', () => {
      brewing(12, 'half');
      const state = log.state();
      assert.deepStrictEqual(limitLines(state, limitsNow()), []);
      assert.equal(formatStatus(state, [], new Map(), []), formatStatus(state));
    });

    it('takes a recipe without concurrency for one with no limit of its own', () => {
      assert.equal(limitsNow().recipe('half'), undefined);
      assert.equal(limitsNow().recipe('nip'), 1);
      assert.equal(limitsNow().recipe('gone'), undefined);
      assert.equal(limitsNow().openOrders, 3);
    });
  });
});
