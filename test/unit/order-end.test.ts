// The end of a split order (ADR 0293): the order's status comment rolls up its sub-orders, says
// when every one merged or which keep it open, and the order's Brewery issue closes with a comment
// once all merged, through the ledger. Recorded events, a fake comments host and a fake GitHub, no
// network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { breweryCloseEffects } from '../../src/engine/brewery-closes.ts';
import { effectMarker } from '../../src/engine/claim-effects.ts';
import type { DriverEffects } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import { pullRequestKey } from '../../src/engine/pull-request.ts';
import { type StatusComments, statusEffects } from '../../src/engine/status-comment.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { PlannedSubOrder } from '../../src/schemas/plan.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const lib = 'acme/lib';
const web = 'acme/web';
const libPull = 'https://github.com/acme/lib/pull/8';
const webPull = 'https://github.com/acme/web/pull/31';
const libRelease = 'https://github.com/acme/lib/releases/tag/v1.4.0';
const routeBy = '2026-11-01T13:00:00.000Z';

const entry = (id: string, repo: string, more: Partial<PlannedSubOrder> = {}): PlannedSubOrder => ({
  id,
  title: `Build ${id}`,
  repo,
  size: { lines: 200, mechanism: 'one module' },
  doneWhen: 'its test passes',
  touches: [{ path: 'src/index.ts' }],
  dependencies: [],
  recipe: 'tdd',
  why: 'a test can pin it',
  ready: true,
  ...more,
});

const ordered = (batchId: string, issue: number, parentBatchId?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue },
  ...(parentBatchId === undefined ? {} : { parentBatchId }),
  routeBy,
});
const brewing = (batchId: string): Event => ({
  type: 'step.scheduled',
  batchId,
  stepId: 'build',
  attempt: 1,
  deadlineAt: routeBy,
});
const opened = (batchId: string, url: string): Event[] => [
  { type: 'effect.applied', key: effectKey.encode(pullRequestKey(batchId)), result: url },
  { type: 'batch.on_tap', batchId, pullRequests: [url] },
];
const ended = (batchId: string, pullRequest: string, state: 'merged' | 'closed'): Event => ({
  type: 'pull_request.ended',
  batchId,
  pullRequest,
  state,
});
const released: Event = {
  type: 'release.observed',
  repo: lib,
  package: '@acme/lib',
  version: 'v1.4.0',
  url: libRelease,
};

/**
 * Order #1, planned by batch 1-1 and split into #2 in acme/lib and #3 in acme/web, which waits for
 * a release of acme/lib, and the sub-orders `more` adds; on tap with no pull request of its own.
 */
const split = (more: { issue: number; entry: PlannedSubOrder }[] = []): Event[] => {
  const entries = [
    { issue: 2, entry: entry('lib', lib) },
    {
      issue: 3,
      entry: entry('web', web, { dependencies: [{ on: 'lib', kind: 'release' }] }),
    },
    ...more,
  ];
  const output = JSON.parse(
    JSON.stringify({
      status: 'done',
      summary: 'A plan',
      assumptions: [],
      subOrders: entries.map(({ entry }) => entry),
    }),
  );
  return [
    ordered('1-1', 1),
    {
      type: 'batch.recipe_chosen',
      batchId: '1-1',
      recipe: 'mash',
      reason: 'label',
      source: 'label',
    },
    { type: 'step.scheduled', batchId: '1-1', stepId: 'plan', attempt: 1, deadlineAt: routeBy },
    {
      type: 'step.started',
      batchId: '1-1',
      stepId: 'plan',
      attempt: 1,
      worktree: {
        repo: brewery,
        path: '/work/plan-1',
        branch: 'foedrum/1-1/plan/1',
        commit: 'c'.repeat(40),
      },
    },
    {
      type: 'step.finished',
      batchId: '1-1',
      stepId: 'plan',
      attempt: 1,
      outcome: { kind: 'succeeded', output },
    },
    {
      type: 'order.decomposed',
      batchId: '1-1',
      subOrders: entries.map(({ issue, entry: { id, repo } }) => ({ issue, repo, entry: id })),
      dependencies: [{ subOrder: 3, blockedBy: 2, kind: 'release' }],
      plan: { stepId: 'plan', attempt: 1 },
    },
    { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
  ];
};

/** #2 merged and acme/lib released after it; #3 ordered and brewing. */
const libReleased: Event[] = [
  ordered('2-1', 2, '1-1'),
  ...opened('2-1', libPull),
  ended('2-1', libPull, 'merged'),
  released,
  ordered('3-1', 3, '1-1'),
  brewing('3-1'),
];
/** Both sub-orders merged. */
const bothMerged: Event[] = [
  ...libReleased,
  ...opened('3-1', webPull),
  ended('3-1', webPull, 'merged'),
];

/** The lines of the status comment the order's batch 1-1 gets for `state`. */
const statusLines = async (state: State): Promise<string[]> => {
  const created: string[] = [];
  const comments: StatusComments = {
    find: async () => undefined,
    read: async () => undefined,
    create: async (_repo, _issue, body) => {
      created.push(body);
      return created.length;
    },
    edit: async () => 'gone',
  };
  const status = statusEffects({
    brewery,
    comments,
    recipes: fakeRecipes({}),
    clock: () => new Date('2026-11-01T12:00:00.000Z'),
  });
  const [key] = status.due(state, '1-1');
  assert.ok(key !== undefined, 'a status revision is due');
  await status.target.apply(effectKey.encode(key));
  return (created[0] ?? '').split('\n');
};

/** Each effect `effects` has due for `batchId`, found first, applied when it is not found. */
const settle = async (effects: DriverEffects, state: State, batchId: string) => {
  const results: unknown[] = [];
  for (const key of effects.due(state, batchId)) {
    const text = effectKey.encode(key);
    const found = await effects.target.find(text);
    results.push(found === undefined ? await effects.target.apply(text) : found.result);
  }
  return results;
};

describe('the end of a split order (ADR 0293)', () => {
  it("rolls up a merged sub-order's release with its tag as recorded", async () => {
    const lines = await statusLines(fold([...split(), ...libReleased]));
    assert.ok(
      lines.includes(`- #2 in acme/lib: <${libPull}>, merged, released as v1.4.0 <${libRelease}>`),
      lines.join('\n'),
    );
  });

  it('rolls up a sub-order with no pull request by its lane', async () => {
    const lines = await statusLines(fold([...split(), ...libReleased]));
    assert.ok(lines.includes('- #3 in acme/web: brewing, no pull request yet'), lines.join('\n'));
    assert.ok(!lines.some((line) => line.startsWith('🍻 **Done**')), lines.join('\n'));
    assert.ok(!lines.some((line) => line.startsWith('Keeps the order open')), lines.join('\n'));
  });

  it("closes the order's issue with a comment once its last sub-order's pull request merges", async () => {
    const github = fakeGitHub();
    const closes = breweryCloseEffects({ marks: github.marks('alice'), brewery });
    assert.deepEqual(await settle(closes, fold([...split(), ...libReleased]), '1-1'), []);
    const state = fold([...split(), ...bothMerged]);
    const lines = await statusLines(state);
    assert.ok(lines.includes('🍻 **Done**: every sub-order merged'), lines.join('\n'));
    await settle(closes, state, '1-1');
    const order = github.issue(brewery, 1);
    assert.equal(order.state, 'closed');
    assert.equal(order.comments.length, 1);
    assert.match(
      order.comments[0]?.body ?? '',
      /^Every sub-order merged: acme\/lib#8, acme\/web#31\. Foedrum closes this order\.\n\n/,
    );
  });

  it('keeps the order open and names a sub-order whose batch a person cancelled', async () => {
    const more = [{ issue: 4, entry: entry('cli', 'acme/cli') }];
    const state = fold([
      ...split(more),
      ...bothMerged,
      ordered('4-1', 4, '1-1'),
      { type: 'batch.cancelled', batchId: '4-1', by: 'ann', via: 'terminal' },
    ]);
    const lines = await statusLines(state);
    assert.ok(lines.includes('- #4 in acme/cli: cancelled, no pull request yet'), lines.join('\n'));
    assert.ok(lines.includes('Keeps the order open: #4 (cancelled)'), lines.join('\n'));
    assert.ok(!lines.some((line) => line.startsWith('🍻 **Done**')), lines.join('\n'));
    const github = fakeGitHub();
    await settle(breweryCloseEffects({ marks: github.marks('alice'), brewery }), state, '1-1');
    assert.equal(github.issue(brewery, 1).state, undefined);
    assert.equal(github.issue(brewery, 1).comments.length, 0);
  });

  it('keeps the order open and names a sub-order whose plan entry needs refinement', async () => {
    const more = [
      { issue: 4, entry: entry('docs', 'acme/docs', { ready: false, refinement: 'which pages' }) },
    ];
    const state = fold([...split(more), ...bothMerged]);
    const lines = await statusLines(state);
    assert.ok(lines.includes('- #4 in acme/docs: needs refinement'), lines.join('\n'));
    assert.ok(lines.includes('Keeps the order open: #4 (needs refinement)'), lines.join('\n'));
    const github = fakeGitHub();
    await settle(breweryCloseEffects({ marks: github.marks('alice'), brewery }), state, '1-1');
    assert.equal(github.issue(brewery, 1).state, undefined);
  });

  it('keeps the order open and names a sub-order whose pull request closed without merging', async () => {
    const state = fold([
      ...split(),
      ...libReleased,
      ...opened('3-1', webPull),
      ended('3-1', webPull, 'closed'),
    ]);
    const lines = await statusLines(state);
    assert.ok(
      lines.includes('Keeps the order open: #3 (closed without merging)'),
      lines.join('\n'),
    );
    const github = fakeGitHub();
    await settle(breweryCloseEffects({ marks: github.marks('alice'), brewery }), state, '1-1');
    assert.equal(github.issue(brewery, 1).state, undefined);
  });

  it('lets a sub-order a later breakdown dropped no longer keep the order open', async () => {
    const three = split([{ issue: 4, entry: entry('cli', 'acme/cli') }]);
    const decomposed = three.find((event) => event.type === 'order.decomposed');
    assert.ok(decomposed?.type === 'order.decomposed');
    // The later breakdown keeps #2 and #3 and leaves #4, which never got a batch, out.
    const again: Event = {
      ...decomposed,
      subOrders: decomposed.subOrders.filter(({ issue }) => issue !== 4),
    };
    const state = fold([...three, again, ...bothMerged]);
    const lines = await statusLines(state);
    assert.ok(lines.includes('🍻 **Done**: every sub-order merged'), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('#4')), lines.join('\n'));
    const github = fakeGitHub();
    await settle(breweryCloseEffects({ marks: github.marks('alice'), brewery }), state, '1-1');
    assert.equal(github.issue(brewery, 1).state, 'closed');
  });

  it("finds the order's close a run applied and was killed before it recorded, and repeats neither", async () => {
    const github = fakeGitHub();
    const key = effectKey.encode({ batchId: '1-1', effect: 'close.comment' });
    const order = github.issue(brewery, 1);
    order.comments.push({
      author: 'alice',
      body: `Every sub-order merged\n\n${effectMarker(key)}`,
    });
    order.state = 'closed';
    const closes = breweryCloseEffects({ marks: github.marks('alice'), brewery });
    const results = await settle(closes, fold([...split(), ...bothMerged]), '1-1');
    assert.deepEqual(results, [1, null]);
    assert.equal(order.comments.length, 1);
    assert.equal(github.calls.get('comment'), undefined);
    assert.equal(github.calls.get('setIssueState'), undefined);
  });

  it("says a split order's own batch has no pull request of its own, not that nothing is built", async () => {
    const lines = await statusLines(fold([...split(), ...bothMerged]));
    assert.ok(
      lines.includes("No pull request of its own: its sub-orders' are listed above."),
      lines.join('\n'),
    );
    assert.ok(
      !lines.some((line) => line.includes('nothing is built from it yet')),
      lines.join('\n'),
    );
  });

  it('closes an order that was never split as before (regression test)', async () => {
    const github = fakeGitHub();
    const state = fold([
      ordered('5-1', 5),
      ...opened('5-1', webPull),
      ended('5-1', webPull, 'merged'),
    ]);
    await settle(breweryCloseEffects({ marks: github.marks('alice'), brewery }), state, '5-1');
    assert.equal(github.issue(brewery, 5).state, 'closed');
    assert.match(github.issue(brewery, 5).comments[0]?.body ?? '', /^Merged as acme\/web#31; /);
  });

  it("closes a sub-order's own issue once its pull request merged, as before (regression test)", async () => {
    const github = fakeGitHub();
    const state = fold([...split(), ...libReleased]);
    await settle(breweryCloseEffects({ marks: github.marks('alice'), brewery }), state, '2-1');
    assert.equal(github.issue(brewery, 2).state, 'closed');
    assert.match(github.issue(brewery, 2).comments[0]?.body ?? '', /^Merged as acme\/lib#8; /);
  });
});
