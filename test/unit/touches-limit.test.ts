// The third limit on what the intake starts (#566, beside ADR 0217): two ready sub-orders whose
// `touches` overlap never run side by side. Recorded events and a fake listing, no network (ADR 0021).

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
import { type Limits, limitLines } from '../../src/engine/limits.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { createdOf } from '../helpers/fake-github-api.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const web = 'acme/web';
const api = 'acme/api';
const now = new Date('2026-10-30T09:00:00.000Z');
const alice: Claimant = { brewery, login: 'alice' };
const recipes = fakeRecipes({ half: fakeRecipe({ steps: ['plan'] }) });
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const unlimited: Limits = { openOrders: 20, recipe: () => undefined };

const issue = (number: number, labels: readonly string[] = ['recipe:half']): TargetIssue => ({
  number,
  state: 'open',
  pullRequest: false,
  labels: [...labels],
  milestone: undefined,
  assignees: [],
  author: 'alice',
  created: createdOf(number),
});

/** A sub-order of order #1's breakdown: its issue, its repository and the paths it touches. */
interface Sub {
  issue: number;
  repo?: string;
  touches?: string[];
}

const heldReason = (holder: number): string =>
  `its touches overlap sub-order #${holder}'s, whose batch is ordered or brewing (touches)`;

describe('two ready sub-orders whose touches overlap (#566)', () => {
  let store: EventStore;
  let log: CommandLog;
  let notices: IntakeNotice[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    notices = [];
  });
  afterEach(() => store.close());

  /** The Brewery's issues `numbers`, each with its recipe label but those `unlabelled`. */
  const tracker = (
    numbers: readonly number[],
    unlabelled: readonly number[] = [],
  ): TargetTracker => ({
    issues: async (repo) =>
      repo === brewery
        ? [1, ...numbers].map((number) =>
            unlabelled.includes(number) ? issue(number, []) : issue(number),
          )
        : [],
    pullRequest: async () => 'open',
  });
  const intake = (
    numbers: readonly number[],
    options: Partial<IntakeOptions> = {},
    unlabelled: readonly number[] = [],
  ) =>
    createIntake({
      log,
      brewery,
      tracker: tracker(numbers, unlabelled),
      claims: fakeGitHub().host,
      claimant: alice,
      authors: ['alice'],
      repositories: [],
      capacity: 10,
      limits: unlimited,
      clock: () => now,
      report: (notice) => notices.push(notice),
      ...options,
    });
  const accept = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const route = (batchId: string): void =>
    accept({ kind: 'route', batchId, recipe: 'half', reason: 'label', source: 'label' });
  /** Order #1 is brewing and broken down into `subs`, all ready, in the plan's order. */
  const breakdown = (subs: readonly Sub[]): number[] => {
    accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
    route('1-1');
    accept({
      kind: 'record',
      event: {
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: subs.map(({ issue: number, repo = web, touches }) =>
          touches === undefined ? { issue: number, repo } : { issue: number, repo, touches },
        ),
        dependencies: [],
      },
    });
    return subs.map((sub) => sub.issue);
  };
  /** The sub-order `number` brews already, ordered and routed by an earlier pass. */
  const brewingAlready = (number: number): void => {
    const batchId = `${number}-1`;
    accept({ kind: 'order', batchId, order: { issue: number }, parentBatchId: '1-1' });
    route(batchId);
  };
  /** The sub-order `number` was ordered by an earlier pass, and its route is held. */
  const orderedAlready = (number: number): void => {
    accept({
      kind: 'order',
      batchId: `${number}-1`,
      order: { issue: number },
      parentBatchId: '1-1',
    });
  };
  const onTap = (batchId: string): void => {
    accept({
      kind: 'record',
      event: { type: 'step.started', batchId, stepId: 'plan', attempt: 1 },
    });
    accept({ kind: 'finish', batchId, stepId: 'plan', attempt: 1, ending: succeeded });
  };
  const lanes = () => [...log.state().batches.values()].map(({ id, lane }) => `${id} ${lane.kind}`);
  const held = () => notices.filter((notice) => notice.kind === 'held');

  describe('what a pass starts', () => {
    it('holds the later of two sub-orders that touch the same path, says so once, and names the sub-order that holds it', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/engine/limits.ts'] },
        { issue: 11, touches: ['src/engine/intake.ts', 'src/engine/limits.ts'] },
      ]);
      const pass = intake(numbers);
      await pass.poll();
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 11, reason: heldReason(10) },
      ]);
    });

    it('holds a sub-order with a path under a folder the other touches', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/engine'] },
        { issue: 11, touches: ['src/engine/limits.ts'] },
      ]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 11, reason: heldReason(10) },
      ]);
    });

    it('holds a sub-order with a folder that holds a path the other touches', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/engine/deep/limits.ts'] },
        { issue: 11, touches: ['src/engine'] },
      ]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 11, reason: heldReason(10) },
      ]);
    });

    it('holds a sub-order against one that comes later in the plan and already brews', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['docs/design/intake/limits.md'] },
        { issue: 11, touches: ['docs/design/intake/limits.md'] },
      ]);
      brewingAlready(11);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '11-1 brewing']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 10, reason: heldReason(11) },
      ]);
    });

    it('takes two spellings of one path for the same path, as a checkout on Windows or macOS does', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/Engine'] },
        { issue: 11, touches: ['src/engine/limits.ts'] },
      ]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 11, reason: heldReason(10) },
      ]);
    });

    it('takes two spellings of one repository for the same repository', async () => {
      const numbers = breakdown([
        { issue: 10, repo: 'acme/Web', touches: ['src/app.ts'] },
        { issue: 11, repo: 'acme/web', touches: ['src/app.ts'] },
      ]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing']);
    });

    it('orders the held sub-order at the next pass once the one that held it is on tap', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/app.ts'] },
        { issue: 11, touches: ['src/app.ts'] },
      ]);
      const pass = intake(numbers);
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing']);
      onTap('10-1');
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 on_tap', '11-1 brewing']);
    });

    it('does not let a held sub-order hold the ones behind it', async () => {
      // 11 overlaps 10 and is held; 12 overlaps only 11, which does not brew.
      const numbers = breakdown([
        { issue: 10, touches: ['src/a.ts'] },
        { issue: 11, touches: ['src/a.ts', 'src/b.ts'] },
        { issue: 12, touches: ['src/b.ts'] },
      ]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing', '12-1 brewing']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 11, reason: heldReason(10) },
      ]);
    });

    it("leaves the recipe's concurrency to the sub-orders that start, not to the one held", async () => {
      // Three may brew at once: order #1, sub-order 10 and 12; the held 11 takes none of them.
      const numbers = breakdown([
        { issue: 10, touches: ['src/a.ts'] },
        { issue: 11, touches: ['src/a.ts', 'src/b.ts'] },
        { issue: 12, touches: ['src/c.ts'] },
      ]);
      await intake(numbers, { limits: { ...unlimited, recipe: () => 3 } }).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing', '12-1 brewing']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 11, reason: heldReason(10) },
      ]);
    });

    it('holds a sub-order against one that an earlier pass ordered and could not route', async () => {
      // 10's issue has no recipe label yet, so it stays Ordered; once labelled it would brew beside 11.
      const numbers = breakdown([
        { issue: 10, touches: ['src/app.ts'] },
        { issue: 11, touches: ['src/app.ts'] },
      ]);
      orderedAlready(10);
      await intake(numbers, {}, [10]).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 ordered']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 11, reason: heldReason(10) },
      ]);
    });

    it('starts a sub-order beside one whose Ordered batch went Stuck', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/app.ts'] },
        { issue: 11, touches: ['src/app.ts'] },
      ]);
      orderedAlready(10);
      const late = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      assert.equal(log.issue({ kind: 'unrouted', batchId: '10-1' }, late).kind, 'accepted');
      await intake(numbers, {}, [10]).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 stuck', '11-1 brewing']);
      assert.deepStrictEqual(held(), []);
    });

    it('drops the touches of a sub-order that the latest breakdown lists without them', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/app.ts'] },
        { issue: 11, touches: ['src/app.ts'] },
      ]);
      orderedAlready(10);
      accept({
        kind: 'record',
        event: {
          type: 'order.decomposed',
          batchId: '1-1',
          subOrders: [
            { issue: 10, repo: web },
            { issue: 11, repo: web, touches: ['src/app.ts'] },
          ],
          dependencies: [],
        },
      });
      await intake(numbers, {}, [10]).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 ordered', '11-1 brewing']);
      assert.deepStrictEqual(held(), []);
    });

    it('starts two sub-orders with disjoint touches side by side', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/a.ts', 'docs/a.md'] },
        { issue: 11, touches: ['src/b.ts', 'docs/b.md'] },
      ]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing', '11-1 brewing']);
      assert.deepStrictEqual(held(), []);
    });

    it('takes a folder for the paths under it, not for the names that only begin like it', async () => {
      const numbers = breakdown([
        { issue: 10, touches: ['src/engine'] },
        { issue: 11, touches: ['src/engine-extra/limits.ts', 'src/engine.ts'] },
      ]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing', '11-1 brewing']);
    });

    it('starts a sub-order without touches beside one that has them', async () => {
      const numbers = breakdown([{ issue: 10, touches: ['src/a.ts'] }, { issue: 11 }]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing', '11-1 brewing']);
    });

    it('starts a sub-order with touches beside one that has none', async () => {
      const numbers = breakdown([{ issue: 10 }, { issue: 11, touches: ['src/a.ts'] }]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing', '11-1 brewing']);
    });

    it('starts two sub-orders of different repositories that touch the same path', async () => {
      const numbers = breakdown([
        { issue: 10, repo: web, touches: ['src/app.ts'] },
        { issue: 11, repo: api, touches: ['src/app.ts'] },
      ]);
      await intake(numbers).poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing', '11-1 brewing']);
    });
  });

  describe('foedrum status', () => {
    const brewingHolder = (): void => {
      breakdown([
        { issue: 10, touches: ['src/app.ts'] },
        { issue: 11, touches: ['src/app.ts'] },
      ]);
      brewingAlready(10);
    };

    it("names the sub-order that holds another, beside the other limits' lines", () => {
      brewingHolder();
      assert.deepStrictEqual(limitLines(log.state(), { ...unlimited, openOrders: 1 }), [
        'open orders: 1 of 1 (#1); new orders wait',
        'sub-order #11 waits for sub-order #10 (10-1): their touches overlap',
      ]);
    });

    it('prints it above the board', () => {
      brewingHolder();
      const lines = limitLines(log.state(), unlimited);
      assert.match(
        formatStatus(log.state(), [], new Map(), lines),
        /^sub-order #11 waits for sub-order #10 \(10-1\): their touches overlap\n\n2 batches\n/,
      );
    });

    it('names a sub-order that holds another while its batch is Ordered', () => {
      breakdown([
        { issue: 10, touches: ['src/app.ts'] },
        { issue: 11, touches: ['src/app.ts'] },
      ]);
      orderedAlready(10);
      assert.deepStrictEqual(limitLines(log.state(), unlimited), [
        'sub-order #11 waits for sub-order #10 (10-1): their touches overlap',
      ]);
    });

    it('prints no such line once the sub-order that held another is on tap', () => {
      brewingHolder();
      onTap('10-1');
      assert.deepStrictEqual(limitLines(log.state(), unlimited), []);
    });

    it('prints no such line for sub-orders whose touches are disjoint', () => {
      breakdown([
        { issue: 10, touches: ['src/a.ts'] },
        { issue: 11, touches: ['src/b.ts'] },
      ]);
      brewingAlready(10);
      assert.deepStrictEqual(limitLines(log.state(), unlimited), []);
    });
  });
});
