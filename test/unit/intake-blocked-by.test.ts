// An issue "blocked by" an open issue on GitHub waits (ADR 0433, #1178): the intake neither claims a
// target issue nor orders a Brewery issue while a blocker is open, takes it at the first pass after
// the last one closed, and leaves a sub-order to the ledger (ADR 0211). A held issue keeps its place
// in the queue, holds no other issue and is said once; nothing is written for it. A fake tracker and
// a fake GitHub, no network (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import {
  createIntake,
  type IntakeNotice,
  type IntakeOptions,
  intakeQueue,
  type TargetTracker,
} from '../../src/engine/intake.ts';
import type { Blocker, Claimant, TargetIssue } from '../../src/engine/issue-claims.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type FakeGitHub, fakeGitHub } from '../helpers/fake-github.ts';
import { createdOf } from '../helpers/fake-github-api.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { addedByAuthor } from '../helpers/labels-added.ts';

const brewery = 'alice/brewery';
const web = 'acme/web';
const api = 'acme/api';
const now = new Date('2026-11-19T09:00:00.000Z');
const alice: Claimant = { brewery, login: 'alice' };
const recipes = fakeRecipes({ half: fakeRecipe({ steps: ['plan'] }) });

/** An open issue of the repository `repo`, which `foedrum` labels as the intake's filter asks. */
const issue = (number: number, fields: Partial<TargetIssue> = {}): TargetIssue => ({
  number,
  state: 'open',
  pullRequest: false,
  labels: ['foedrum'],
  milestone: undefined,
  assignees: [],
  author: 'alice',
  created: createdOf(number),
  blockedBy: 0,
  ...fields,
});
/** A Brewery issue with a recipe label, which the intake orders. */
const labelled = (number: number, fields: Partial<TargetIssue> = {}): TargetIssue =>
  issue(number, { labels: ['recipe:half'], ...fields });
const open = (repo: string, number: number): Blocker => ({ repo, number, state: 'open' });
const closed = (repo: string, number: number): Blocker => ({ repo, number, state: 'closed' });

describe('an issue blocked by an open issue on GitHub (ADR 0433)', () => {
  let store: EventStore;
  let log: CommandLog;
  let github: FakeGitHub;
  let notices: IntakeNotice[];
  /** The open issues of each repository, which a test changes between two passes. */
  let listed: Record<string, TargetIssue[]>;
  /** What GitHub lists as blocking `<repo>#<n>`, or the error its read fails with. */
  let links: Record<string, Blocker[] | Error>;
  /** Each blocker read the pass made, as `<repo>#<n>`. */
  let reads: string[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    github = fakeGitHub();
    notices = [];
    listed = { [brewery]: [], [web]: [] };
    links = {};
    reads = [];
  });
  afterEach(() => store.close());

  const tracker = (): TargetTracker => ({
    issues: async (repo) => listed[repo] ?? [],
    pullRequest: async () => 'open',
    labelsAdded: addedByAuthor((repo) => listed[repo]),
    blockers: async (repo, number) => {
      reads.push(`${repo}#${number}`);
      const found = links[`${repo}#${number}`];
      if (found instanceof Error) throw found;
      return found ?? [];
    },
  });
  const intake = (options: Partial<IntakeOptions> = {}) =>
    createIntake({
      log,
      brewery,
      tracker: tracker(),
      claims: github.host,
      claimant: alice,
      authors: ['alice'],
      repositories: [{ repo: web, alias: 'web', filter: { labels: ['foedrum'] } }],
      capacity: 5,
      clock: () => now,
      report: (notice) => notices.push(notice),
      ...options,
    });
  const accept = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const lanes = () => [...log.state().batches.values()].map(({ id, lane }) => `${id} ${lane.kind}`);
  const held = () => notices.filter((notice) => notice.kind === 'held');

  describe('a target issue', () => {
    it('is not claimed while an issue it is blocked by is open, and nothing is written for it', async () => {
      listed[web] = [issue(7, { blockedBy: 1 })];
      links[`${web}#7`] = [open(web, 3)];
      const recorded = store.lastEventId();
      await intake().poll();
      assert.deepStrictEqual(lanes(), []);
      assert.equal(store.lastEventId(), recorded);
      assert.deepStrictEqual([...github.refs.keys()], []);
      assert.deepStrictEqual([...github.calls.keys()], []);
      assert.deepStrictEqual(github.issue(web, 7), { assignees: [], labels: [], comments: [] });
      assert.deepStrictEqual(reads, [`${web}#7`]);
    });

    it('is said to wait once, with the blocker that holds it', async () => {
      listed[web] = [issue(7, { blockedBy: 1 })];
      links[`${web}#7`] = [open(web, 3)];
      const pass = intake();
      await pass.poll();
      await pass.poll();
      await pass.poll();
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: web, issue: 7, reason: 'blocked by #3 (open)' },
      ]);
    });

    it('names a blocker in another repository by its repository', async () => {
      listed[web] = [issue(7, { blockedBy: 1 })];
      links[`${web}#7`] = [open(api, 5)];
      await intake().poll();
      assert.deepStrictEqual(lanes(), []);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: web, issue: 7, reason: `blocked by ${api}#5 (open)` },
      ]);
    });

    it('waits while any of its blockers is open, though another one closed', async () => {
      listed[web] = [issue(7, { blockedBy: 1 })];
      links[`${web}#7`] = [closed(web, 3), open(web, 4)];
      await intake().poll();
      assert.deepStrictEqual(lanes(), []);
      assert.deepStrictEqual(
        held().map((notice) => notice.reason.includes('#4 (open)')),
        [true],
      );
    });

    it('is claimed at the first pass after its last blocker closed', async () => {
      listed[web] = [issue(7, { blockedBy: 1 })];
      links[`${web}#7`] = [open(web, 3)];
      const pass = intake();
      await pass.poll();
      assert.deepStrictEqual(lanes(), []);
      // The blocker closed: GitHub's `blocked_by` counts open blockers only.
      listed[web] = [issue(7)];
      links[`${web}#7`] = [closed(web, 3)];
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['web-7 ordered']);
      assert.deepStrictEqual([...github.refs.keys()], [`${web}#7`]);
      assert.deepStrictEqual(reads, [`${web}#7`]);
    });

    it('is claimed when its blocker was closed as not planned: the read finds it closed', async () => {
      // The listing counted one blocker a moment ago, and the links say it closed since.
      listed[web] = [issue(7, { blockedBy: 1 })];
      links[`${web}#7`] = [closed(web, 3)];
      await intake().poll();
      // It reads the links the listing counted, and finds none open.
      assert.deepStrictEqual(reads, [`${web}#7`]);
      assert.deepStrictEqual(lanes(), ['web-7 ordered']);
      assert.deepStrictEqual(held(), []);
    });

    it('holds no other issue, and takes none of the free capacity', async () => {
      listed[web] = [issue(7, { blockedBy: 1 }), issue(8)];
      links[`${web}#7`] = [open(web, 3)];
      await intake({ capacity: 1 }).poll();
      assert.deepStrictEqual(lanes(), ['web-8 ordered']);
      assert.deepStrictEqual([...github.refs.keys()], [`${web}#8`]);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: web, issue: 7, reason: 'blocked by #3 (open)' },
      ]);
    });

    it('is not claimed when the read of its blockers fails, and the pass goes on with the rest', async () => {
      listed[web] = [issue(7, { blockedBy: 1 }), issue(8)];
      links[`${web}#7`] = new Error('502 reading the blockers');
      await intake().poll();
      assert.deepStrictEqual(lanes(), ['web-8 ordered']);
      const failures = notices.flatMap((notice) =>
        notice.kind === 'failed' && notice.what.includes(`${web}#7`) ? [notice.what] : [],
      );
      assert.ok(failures.length > 0, JSON.stringify(notices));
    });

    it('has its blockers read only when the walk reaches it with a free slot', async () => {
      listed[web] = [issue(6), issue(7, { blockedBy: 1 })];
      links[`${web}#7`] = [open(web, 3)];
      await intake({ capacity: 1 }).poll();
      assert.deepStrictEqual(lanes(), ['web-6 ordered']);
      assert.deepStrictEqual(reads, []);
      assert.deepStrictEqual(held(), []);
    });

    it('has its blockers read only when no limit holds it', async () => {
      listed[web] = [issue(6), issue(7, { blockedBy: 1 })];
      links[`${web}#7`] = [open(web, 3)];
      await intake({ limits: { openOrders: 1, recipe: () => undefined } }).poll();
      assert.deepStrictEqual(lanes(), ['web-6 ordered']);
      assert.deepStrictEqual(reads, []);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: web, issue: 7, reason: "1 order is open, the Brewery's openOrders" },
      ]);
    });

    it('is claimed at once, with no read of its blockers, when its listing counts none (regression test)', async () => {
      listed[web] = [issue(7)];
      await intake().poll();
      assert.deepStrictEqual(lanes(), ['web-7 ordered']);
      assert.deepStrictEqual(reads, []);
      assert.deepStrictEqual(held(), []);
    });
  });

  describe('a Brewery issue with a recipe label (ADR 0068)', () => {
    it('is not ordered while an issue it is blocked by is open, and nothing is written for it', async () => {
      listed[brewery] = [labelled(12, { blockedBy: 1 })];
      links[`${brewery}#12`] = [open(brewery, 11)];
      const recorded = store.lastEventId();
      const pass = intake();
      await pass.poll();
      await pass.poll();
      assert.deepStrictEqual(lanes(), []);
      assert.equal(store.lastEventId(), recorded);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 12, reason: 'blocked by #11 (open)' },
      ]);
    });

    it('is ordered at the first pass after its last blocker closed', async () => {
      listed[brewery] = [labelled(12, { blockedBy: 1 })];
      links[`${brewery}#12`] = [open(brewery, 11)];
      const pass = intake();
      await pass.poll();
      assert.deepStrictEqual(lanes(), []);
      listed[brewery] = [labelled(12)];
      links[`${brewery}#12`] = [closed(brewery, 11)];
      await pass.poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing']);
    });

    it('holds no other Brewery issue', async () => {
      listed[brewery] = [labelled(12, { blockedBy: 1 }), labelled(13)];
      links[`${brewery}#12`] = [open(web, 3)];
      await intake().poll();
      assert.deepStrictEqual(lanes(), ['13-1 brewing']);
      assert.deepStrictEqual(held(), [
        { kind: 'held', repo: brewery, issue: 12, reason: `blocked by ${web}#3 (open)` },
      ]);
    });

    it('is ordered with no read of its blockers when its listing counts none (regression test)', async () => {
      listed[brewery] = [labelled(12)];
      await intake().poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing']);
      assert.deepStrictEqual(reads, []);
    });
  });

  describe('a sub-order (ADR 0211)', () => {
    it('is left to the ledger: it starts once its blockers merged, though GitHub still lists its blocker as open (regression test)', async () => {
      accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
      accept({
        kind: 'route',
        batchId: '1-1',
        recipe: 'half',
        reason: 'label',
        source: 'label',
      });
      accept({
        kind: 'record',
        event: {
          type: 'order.decomposed',
          batchId: '1-1',
          subOrders: [{ issue: 10, repo: web }],
          dependencies: [],
        },
      });
      // The pull request of its blocker merged, which will close the blocker's issue: not yet.
      listed[brewery] = [
        labelled(1),
        labelled(10, { labels: ['recipe:half', 'foedrum:sub-order'], blockedBy: 1 }),
      ];
      links[`${brewery}#10`] = [open(brewery, 9)];
      await intake().poll();
      assert.deepStrictEqual(lanes(), ['1-1 brewing', '10-1 brewing']);
      assert.deepStrictEqual(reads, []);
      assert.deepStrictEqual(held(), []);
    });
  });

  describe('the queue', () => {
    it('keeps a blocked issue at its rank, so it holds its place (regression test)', () => {
      const blocked = issue(7, { blockedBy: 2, labelsAdded: [{ label: 'foedrum', by: 'alice' }] });
      const free = issue(8, { labelsAdded: [{ label: 'foedrum', by: 'alice' }] });
      const queue = intakeQueue(
        log.state(),
        {
          brewery: [],
          repositories: [
            {
              repository: { repo: web, alias: 'web', filter: { labels: ['foedrum'] } },
              issues: [free, blocked],
            },
          ],
        },
        { authors: ['alice'], claimant: alice },
      );
      assert.deepStrictEqual(
        queue.map(({ order }) => order.issue),
        [7, 8],
      );
    });
  });
});
