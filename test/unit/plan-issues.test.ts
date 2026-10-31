// An approved plan as Brewery sub-issues (ADR 0285): the driver applies each issue, its place under
// the order and its "blocked by" links through the ledger, once, also after a kill, and records
// `order.decomposed` after the last; the adapter of #723 against the fake GitHub API, no network
// (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import { combineEffects } from '../../src/engine/effects.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { PLAN_HEADING, planEffects } from '../../src/engine/plan-comment.ts';
import { openedSubIssues, planIssueEffects } from '../../src/engine/plan-issues.ts';
import { readySubOrders } from '../../src/engine/ready-set.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type StatusComments, statusEffects } from '../../src/engine/status-comment.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubSubIssues } from '../../src/github/sub-issues.ts';
import type { PlannedSubOrder, PlanReport } from '../../src/schemas/plan.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const login = 'alice';
const at = new Date('2026-10-31T09:00:00.000Z');

const subOrder = (id: string, more: Partial<PlannedSubOrder> = {}): PlannedSubOrder => ({
  id,
  title: `Build ${id}`,
  repo: 'acme/api',
  size: { lines: 300, mechanism: 'one endpoint' },
  doneWhen: `${id} answers 200`,
  touches: [{ path: `src/${id}.ts` }],
  dependencies: [],
  recipe: 'tdd',
  why: 'a test can pin it',
  ready: true,
  ...more,
});

/** Three sub-orders: `ui` waits for `api`'s code, `cli` for its release and needs refining. */
const three: PlanReport = {
  subOrders: [
    subOrder('api'),
    subOrder('ui', {
      repo: 'acme/web',
      dependencies: [{ on: 'api', kind: 'code' }],
      recipe: 'docs',
    }),
    subOrder('cli', {
      dependencies: [{ on: 'api', kind: 'release' }],
      ready: false,
      refinement: 'the flags are open',
    }),
  ],
};

const planned = (plan: PlanReport): Ending => ({
  kind: 'succeeded',
  // Through JSON, as the event log keeps an outcome.
  output: JSON.parse(
    JSON.stringify({ status: 'done', summary: 'A plan', assumptions: [], ...plan }),
  ),
});

/**
 * A `fetch` over the fake API that answers the `n`th request `matches` picks with `answer`, after it
 * landed, or with it alone when it `lands` not.
 */
const losing = (
  api: FakeGitHubApi,
  matches: (method: string, path: string) => boolean,
  n: number,
  answer: () => Response = () => {
    throw new Error('killed before the answer came');
  },
  lands = true,
): typeof globalThis.fetch => {
  let seen = 0;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const { pathname } = new URL(String(input));
    const picked = matches(init.method ?? 'GET', pathname) && ++seen === n;
    if (picked && !lands) return answer();
    const response = await api.fetch(input, init);
    return picked ? answer() : response;
  }) as typeof globalThis.fetch;
};

describe('planIssueEffects (ADR 0285)', () => {
  const recipes = fakeRecipes({
    // One plan step and no pull request: its plan waits for review (ADR 0275).
    pale: fakeRecipe({ steps: ['plan'], pullRequests: [] }),
    half: fakeRecipe({ steps: ['build'] }),
  });
  let store: EventStore;
  let log: CommandLog;
  let api: FakeGitHubApi;
  let notices: DriverNotice[];
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    api = fakeGitHubApi({
      login,
      issues: {
        [brewery]: [{ number: 7, labels: ['recipe:pale'], author: login, title: 'Order' }],
      },
    });
    notices = [];
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const open = async (
    fetch: typeof globalThis.fetch = api.fetch,
    comments?: StatusComments,
  ): Promise<Driver> => {
    const client = createGitHubClient({ exec: ghOver(fetch).exec });
    const planIssues = planIssueEffects({ subIssues: githubSubIssues({ client, brewery, login }) });
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => at,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects:
        comments === undefined
          ? planIssues
          : combineEffects(
              planIssues,
              statusEffects({ brewery, comments, recipes, clock: () => at }),
              planEffects({ brewery, comments }),
            ),
      report: (notice) => notices.push(notice),
    });
    drivers.push(driver);
    return driver;
  };
  const issue = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, at);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  /** Order 7 planned as `three`, and the plan approved: the batch is on tap. */
  const approved = (): void => {
    issue({ kind: 'order', batchId: '7-1', order: { issue: 7 } });
    issue({ kind: 'route', batchId: '7-1', recipe: 'pale', reason: 'label', source: 'label' });
    const ref = { batchId: '7-1', stepId: 'plan', attempt: 1 };
    issue({ kind: 'record', event: { type: 'step.started', ...ref } });
    issue({ kind: 'finish', ...ref, ending: planned(three) });
    issue({ kind: 'approve', batchId: '7-1', by: 'grace', via: 'terminal' });
    assert.equal(log.state().batches.get('7-1')?.lane.kind, 'on_tap');
  };
  const opened = () =>
    api.issues[brewery]
      ?.filter(({ number }) => number !== 7)
      .map(({ number, title, labels, blockedBy }) => ({ number, title, labels, blockedBy }));
  const posts = (path: string) =>
    api.requests.filter((request) => request === `POST /repos/alice/brewery/${path}`).length;
  const failed = () => notices.filter(({ kind }) => kind === 'effect_failed');
  /** What a whole run leaves on GitHub: three issues under order 7, each with its labels and links. */
  const created = [
    { number: 8, title: 'Build api', labels: ['recipe:tdd'], blockedBy: undefined },
    { number: 9, title: 'Build ui', labels: ['recipe:docs'], blockedBy: [8] },
    { number: 10, title: 'Build cli', labels: ['recipe:tdd', 'needs-refinement'], blockedBy: [8] },
  ];

  it('creates three Brewery sub-issues of an approved plan with their labels and "blocked by" links, once', async () => {
    approved();
    const driver = await open();
    await driver.applyEffects();
    await driver.applyEffects();
    assert.deepStrictEqual(failed(), []);
    assert.deepStrictEqual(opened(), created);
    assert.deepStrictEqual(api.issue(brewery, 7)?.subIssues, [8, 9, 10]);
    assert.equal(posts('issues'), 3);
    assert.equal(posts('issues/7/sub_issues'), 3);
    assert.deepStrictEqual(openedSubIssues(log.state(), '7-1'), [
      { id: 'api', number: 8 },
      { id: 'ui', number: 9 },
      { id: 'cli', number: 10 },
    ]);
  });

  it('creates nothing twice after a kill between two effects, and the next run finishes the rest', async () => {
    approved();
    const isOpen = (method: string, path: string) =>
      method === 'POST' && path === '/repos/alice/brewery/issues';
    // The second issue lands on GitHub, and the run is killed before its answer comes.
    const first = await open(losing(api, isOpen, 2));
    await first.applyEffects();
    assert.equal(failed().length, 1);
    assert.equal(api.issues[brewery]?.length, 3);
    assert.deepStrictEqual(log.state().orders.get(7)?.subOrders, []);
    for (const driver of drivers.splice(0)) driver.close();
    const second = await open();
    await second.applyEffects();
    assert.equal(failed().length, 1);
    assert.deepStrictEqual(opened(), created);
    assert.deepStrictEqual(api.issue(brewery, 7)?.subIssues, [8, 9, 10]);
    assert.equal(posts('issues'), 3);
  });

  it("reads back a repeated sub-issue add that GitHub refuses with 422 from the order's list, not failed", async () => {
    approved();
    const isAdd = (method: string, path: string) =>
      method === 'POST' && path === '/repos/alice/brewery/issues/7/sub_issues';
    // The add lands, and the answer the run gets is the refusal of a repeat.
    const refusal = () =>
      new Response(
        JSON.stringify({
          message:
            'An error occurred while adding the sub-issue to the parent issue. Issue may not contain duplicate sub-issues and Sub issue may only have one parent',
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      );
    const driver = await open(losing(api, isAdd, 1, refusal));
    await driver.applyEffects();
    assert.deepStrictEqual(failed(), []);
    assert.deepStrictEqual(api.issue(brewery, 7)?.subIssues, [8, 9, 10]);
    assert.deepStrictEqual(log.state().orders.get(7)?.subOrders, [8, 9, 10]);
  });

  it('records order.decomposed after the last effect, and the ready set starts the unblocked sub-order', async () => {
    approved();
    // The last "blocked by" link fails and does not land: nothing is decomposed yet.
    const isLink = (method: string, path: string) =>
      method === 'POST' && path.endsWith('/dependencies/blocked_by');
    const serverError = () => new Response('{"message":"Server Error"}', { status: 500 });
    const first = await open(losing(api, isLink, 2, serverError, false));
    await first.applyEffects();
    assert.equal(failed().length, 1);
    assert.deepStrictEqual(log.state().orders.get(7)?.subOrders, []);
    assert.deepStrictEqual(readySubOrders(log.state()), []);
    for (const driver of drivers.splice(0)) driver.close();
    await (await open()).applyEffects();
    const order = log.state().orders.get(7);
    assert.deepStrictEqual(order?.subOrders, [8, 9, 10]);
    assert.deepStrictEqual(order?.dependencies, [
      { subOrder: 9, blockedBy: 8, kind: 'code' },
      { subOrder: 10, blockedBy: 8, kind: 'release' },
    ]);
    assert.deepStrictEqual(log.state().subOrders.get(9)?.repo, 'acme/web');
    assert.deepStrictEqual(readySubOrders(log.state()), [
      {
        order: 7,
        issue: 8,
        parentBatchId: '7-1',
        plan: { batchId: '7-1', stepId: 'plan', attempt: 1, entry: 'api' },
      },
    ]);
  });

  it('opens nothing for a plan that waits for its review, nor for a batch on tap without a plan', async () => {
    issue({ kind: 'order', batchId: '7-1', order: { issue: 7 } });
    issue({ kind: 'route', batchId: '7-1', recipe: 'pale', reason: 'label', source: 'label' });
    const ref = { batchId: '7-1', stepId: 'plan', attempt: 1 };
    issue({ kind: 'record', event: { type: 'step.started', ...ref } });
    issue({ kind: 'finish', ...ref, ending: planned(three) });
    issue({ kind: 'order', batchId: '5-1', order: { issue: 5 } });
    issue({ kind: 'route', batchId: '5-1', recipe: 'half', reason: 'label', source: 'label' });
    const build = { batchId: '5-1', stepId: 'build', attempt: 1 };
    issue({ kind: 'record', event: { type: 'step.started', ...build } });
    issue({
      kind: 'finish',
      ...build,
      ending: { kind: 'succeeded', output: { status: 'done', summary: 'Built', assumptions: [] } },
    });
    assert.equal(log.state().batches.get('7-1')?.lane.kind, 'stuck');
    assert.equal(log.state().batches.get('5-1')?.lane.kind, 'on_tap');
    const driver = await open();
    await driver.applyEffects();
    assert.deepStrictEqual(api.requests, []);
    assert.deepStrictEqual(openedSubIssues(log.state(), '7-1'), []);
  });

  it('admits the breakdown from the approved batch on tap only for the approved attempt: regression test', () => {
    approved();
    const breakdown = (plan?: { stepId: string; attempt: number }) =>
      log.issue(
        {
          kind: 'record',
          event: {
            type: 'order.decomposed',
            batchId: '7-1',
            subOrders: [{ issue: 8, repo: 'acme/api', entry: 'api' }],
            dependencies: [],
            ...(plan === undefined ? {} : { plan }),
          },
        },
        at,
      ).kind;
    assert.equal(breakdown(), 'refused');
    assert.equal(breakdown({ stepId: 'plan', attempt: 2 }), 'refused');
    assert.equal(breakdown({ stepId: 'replan', attempt: 1 }), 'refused');
    assert.equal(breakdown({ stepId: 'plan', attempt: 1 }), 'accepted');
    assert.deepStrictEqual(log.state().orders.get(7)?.subOrders, [8]);
  });

  it('names the sub-issues in the plan comment and on the On tap line of the status comment: regression test', async () => {
    approved();
    const bodies = new Map<number, { issue: number; body: string }>();
    let ids = 0;
    const comments: StatusComments = {
      find: async (_repo, issue, marker) => {
        const found = [...bodies].find(([, c]) => c.issue === issue && c.body.endsWith(marker));
        return found === undefined ? undefined : { id: found[0], body: found[1].body };
      },
      read: async (_repo, id) => bodies.get(id)?.body,
      create: async (_repo, issue, body) => {
        bodies.set(++ids, { issue, body });
        return ids;
      },
      edit: async (_repo, id, body) => {
        const found = bodies.get(id);
        if (found === undefined) return 'gone';
        found.body = body;
        return 'edited';
      },
    };
    const driver = await open(api.fetch, comments);
    await driver.applyEffects();
    assert.deepStrictEqual(failed(), []);
    const texts = [...bodies.values()].map(({ body }) => body);
    const plan = texts.find((body) => body.startsWith(PLAN_HEADING)) ?? '';
    assert.ok(plan.includes('\n\nSub-issues: `api` #8, `ui` #9, `cli` #10.\n'), plan);
    const status = texts.find((body) => !body.startsWith(PLAN_HEADING)) ?? '';
    const onTap = '🍻 **On tap**: plan approved by grace (terminal); sub-issues #8, #9, #10';
    assert.ok(status.split('\n').includes(onTap), status);
  });
});
