// The pull requests of one order name each other and the merge order (ADR 0292): a section of each
// sub-order pull request's body, revised through the ledger as its siblings open and end, and the
// order's status comment, which lists them. Recorded events and a fake code host, no network
// (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import {
  bodyOwner,
  MAX_SIBLINGS,
  pullRequestKey,
  pullRequestText,
} from '../../src/engine/pull-request.ts';
import type { PullRequestHost } from '../../src/engine/pull-request-actions.ts';
import {
  siblingEffects,
  siblingSection,
  subOrderPullRequests,
} from '../../src/engine/sibling-pull-requests.ts';
import { type StatusComments, statusEffects } from '../../src/engine/status-comment.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const lib = 'acme/lib-core';
const web = 'acme/web';
const libPull = 'https://github.com/acme/lib-core/pull/7';
const webPull = 'https://github.com/acme/web/pull/12';
const routeBy = '2026-10-31T13:00:00.000Z';

const ordered = (batchId: string, issue: number, parentBatchId?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue },
  ...(parentBatchId === undefined ? {} : { parentBatchId }),
  routeBy,
});
/** The ledger's open of `batchId`'s pull request, and the batch on tap with it. */
const opened = (batchId: string, url: string): Event[] => [
  { type: 'effect.applied', key: effectKey.encode(pullRequestKey(batchId)), result: url },
  { type: 'batch.on_tap', batchId, pullRequests: [url] },
];
const merged = (batchId: string, pullRequest: string): Event => ({
  type: 'pull_request.ended',
  batchId,
  pullRequest,
  state: 'merged',
});

/**
 * Order #1 split into #3 in acme/web, listed first, and #2 in acme/lib-core, which #3 waits for a
 * release of: the merge order is the dependencies', not the plan's.
 */
const decomposed: Event[] = [
  ordered('1-1', 1),
  {
    type: 'order.decomposed',
    batchId: '1-1',
    subOrders: [
      { issue: 3, repo: web },
      { issue: 2, repo: lib },
    ],
    dependencies: [{ subOrder: 3, blockedBy: 2, kind: 'release' }],
  },
  { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
  ordered('2-1', 2, '1-1'),
  ordered('3-1', 3, '1-1'),
];

/** The body Foedrum opened `batchId`'s pull request with, from its sub-order #`issue`. */
const openedBody = (batchId: string, issue: number): string =>
  pullRequestText({
    title: 'Order',
    closes: { repo: brewery, issue },
    reports: [{ stepId: 'build', summary: 'Built it.', assumptions: [] }],
    key: pullRequestKey(batchId),
  }).body;

/** A code host with the bodies of the pull requests, by URL, recording each update. */
const fakeHost = (bodies: Record<string, string>) => {
  const updates: { url: string; body: string }[] = [];
  const host: Pick<PullRequestHost, 'body' | 'update'> = {
    body: async (url) => bodies[url] ?? assert.fail(`no pull request ${url}`),
    update: async (url, body) => {
      updates.push({ url, body });
      bodies[url] = body;
    },
  };
  return { host, updates, bodies };
};

/**
 * One pass of the driver over the effects of `batchIds`: each due key found first, else applied,
 * and recorded. `killAfter` stops before the record of that many applied effects, as a kill does.
 */
const pass = async (
  effects: ReturnType<typeof siblingEffects>,
  state: State,
  batchIds: readonly string[],
  killAfter?: number,
): Promise<State> => {
  let current = state;
  let applied = 0;
  for (const batchId of batchIds) {
    for (const key of effects.due(current, batchId)) {
      const text = effectKey.encode(key);
      if (current.effects.has(text)) continue;
      const found = await effects.target.find(text);
      const result = found === undefined ? await effects.target.apply(text) : found.result;
      if (found === undefined && killAfter !== undefined && ++applied > killAfter) return current;
      current = fold([{ type: 'effect.applied', key: text, result }], current);
    }
  }
  return current;
};

describe('sibling pull requests (ADR 0292)', () => {
  it('names the second pull request in the first one once the second opens', async () => {
    // As the intake brews them: #3 has no batch until #2's pull request merged (ADR 0211).
    const libOnly = fold([...decomposed, ...opened('2-1', libPull)]);
    const { host, bodies } = fakeHost({ [libPull]: openedBody('2-1', 2) });
    const effects = siblingEffects({ host });
    const before = await pass(effects, libOnly, ['2-1', '3-1']);
    assert.doesNotMatch(bodies[libPull] ?? '', /acme\/web#12/);
    bodies[webPull] = openedBody('3-1', 3);
    const libMerged = fold([merged('2-1', libPull), ...opened('3-1', webPull)], before);
    await pass(effects, libMerged, ['2-1', '3-1']);
    assert.match(bodies[libPull] ?? '', /acme\/web#12/);
    assert.match(bodies[webPull] ?? '', /acme\/lib-core#7/);
    // Still Foedrum's own, so a later round renders it again (ADR 0227).
    assert.equal(bodyOwner('2-1', bodies[libPull] ?? '').kind, 'own');
  });

  it('gives both pull requests the merge order of the plan dependencies', () => {
    const state = fold([...decomposed, ...opened('2-1', libPull), ...opened('3-1', webPull)]);
    assert.deepEqual(
      subOrderPullRequests(state, 1).map(({ subOrder, pullRequest, state }) => [
        subOrder,
        pullRequest,
        state,
      ]),
      [
        [2, libPull, 'open'],
        [3, webPull, 'open'],
      ],
    );
    // Each body names itself as this pull request, and its sibling by its reference.
    assert.deepEqual((siblingSection(state, '2-1') ?? '').split('\n').slice(2, 4), [
      '1. This pull request, in acme/lib-core: merge first (acme/web#12 waits for its release).',
      '2. acme/web#12: open, merge after this pull request merges and acme/lib-core has a release after it.',
    ]);
    assert.deepEqual((siblingSection(state, '3-1') ?? '').split('\n').slice(2, 4), [
      '1. acme/lib-core#7: open, merge first (this pull request waits for its release).',
      '2. This pull request, in acme/web: merge after acme/lib-core#7 merges and acme/lib-core has a release after it.',
    ]);
  });

  it("renders the open's section as the next pass finds it, so the open needs no second write", async () => {
    const before = fold([...decomposed, ...opened('2-1', libPull)]);
    const atOpen = siblingSection(before, '3-1') ?? assert.fail('no section');
    const { host, updates } = fakeHost({
      [libPull]: openedBody('2-1', 2),
      [webPull]: pullRequestText({
        title: 'Order',
        closes: { repo: brewery, issue: 3 },
        reports: [],
        key: pullRequestKey('3-1'),
        siblings: atOpen,
      }).body,
    });
    const settled = await pass(siblingEffects({ host }), before, ['2-1']);
    updates.length = 0;
    const after = await pass(siblingEffects({ host }), fold(opened('3-1', webPull), settled), [
      '3-1',
    ]);
    assert.equal(after.effects.size, settled.effects.size + 2);
    assert.deepEqual(updates, []);
  });

  it('stops writing a merged body once every sibling has a pull request', async () => {
    const both = fold([
      ...decomposed,
      ...opened('2-1', libPull),
      merged('2-1', libPull),
      ...opened('3-1', webPull),
    ]);
    const { host, updates } = fakeHost({
      [libPull]: openedBody('2-1', 2),
      [webPull]: openedBody('3-1', 3),
    });
    const settled = await pass(siblingEffects({ host }), both, ['2-1', '3-1']);
    assert.deepEqual(updates.map(({ url }) => url).sort(), [libPull, webPull]);
    updates.length = 0;
    await pass(siblingEffects({ host }), fold([merged('3-1', webPull)], settled), ['2-1', '3-1']);
    // The merged lib-core body names every sibling already, so a later end leaves it as it is.
    assert.deepEqual(updates, []);
  });

  it('renders the opened body with the sibling section first', () => {
    const state = fold([...decomposed, ...opened('2-1', libPull)]);
    const section = siblingSection(state, '3-1') ?? assert.fail('no section');
    const { body } = pullRequestText({
      title: 'Order',
      closes: { repo: brewery, issue: 3 },
      reports: [],
      key: pullRequestKey('3-1'),
      siblings: section,
    });
    assert.ok(body.startsWith(section), body);
    assert.match(section, /acme\/lib-core#7/);
  });

  it('renders the body again when a sibling merges', async () => {
    const both = fold([...decomposed, ...opened('2-1', libPull), ...opened('3-1', webPull)]);
    const { host, bodies, updates } = fakeHost({
      [libPull]: openedBody('2-1', 2),
      [webPull]: openedBody('3-1', 3),
    });
    const effects = siblingEffects({ host });
    const settled = await pass(effects, both, ['2-1', '3-1']);
    assert.match(bodies[webPull] ?? '', /acme\/lib-core#7[^\n]*open/);
    updates.length = 0;
    await pass(effects, fold([merged('2-1', libPull)], settled), ['2-1', '3-1']);
    // Only the open one: a merged pull request's body is the merge commit's already.
    assert.deepEqual(
      updates.map(({ url }) => url),
      [webPull],
    );
    assert.match(bodies[webPull] ?? '', /acme\/lib-core#7[^\n]*merged/);
  });

  it('names neither the Brewery issue nor the Brewery repository in the sibling section', () => {
    const state = fold([...decomposed, ...opened('2-1', libPull), ...opened('3-1', webPull)]);
    for (const batchId of ['2-1', '3-1']) {
      const section = siblingSection(state, batchId) ?? assert.fail('no section');
      assert.doesNotMatch(section, /alice\/brewery|brewery/i);
      // No bare issue number: GitHub would link it to the target repository's own issue.
      assert.doesNotMatch(section, /(^|[^\w/-])#\d/m);
    }
  });

  it('leaves a body a person edited as it is', async () => {
    const both = fold([...decomposed, ...opened('2-1', libPull), ...opened('3-1', webPull)]);
    const edited = `${openedBody('2-1', 2)}\n\nA reviewer's note.`;
    const { host, bodies, updates } = fakeHost({
      [libPull]: edited,
      [webPull]: openedBody('3-1', 3),
    });
    const settled = await pass(siblingEffects({ host }), both, ['2-1', '3-1']);
    assert.equal(bodies[libPull], edited);
    assert.deepEqual(
      updates.map(({ url }) => url),
      [webPull],
    );
    // Recorded as left, so the next pass asks nothing again.
    updates.length = 0;
    await pass(siblingEffects({ host }), settled, ['2-1', '3-1']);
    assert.deepEqual(updates, []);
  });

  it('writes nothing twice after a kill between two body updates', async () => {
    const both = fold([...decomposed, ...opened('2-1', libPull), ...opened('3-1', webPull)]);
    const { host, bodies, updates } = fakeHost({
      [libPull]: openedBody('2-1', 2),
      [webPull]: openedBody('3-1', 3),
    });
    // The first body is updated and the driver killed before it records it.
    const killed = await pass(siblingEffects({ host }), both, ['2-1', '3-1'], 0);
    assert.equal(updates.length, 1);
    assert.equal(killed.effects.size, both.effects.size);
    const after = await pass(siblingEffects({ host }), killed, ['2-1', '3-1']);
    assert.deepEqual(
      updates.map(({ url }) => url),
      [libPull, webPull],
    );
    assert.equal(after.effects.size, both.effects.size + 2);
    assert.equal(bodyOwner('2-1', bodies[libPull] ?? '').kind, 'own');
  });

  it("lists the sub-orders' pull requests with their state in the order's status comment", async () => {
    const state = fold([...decomposed, ...opened('2-1', libPull), merged('2-1', libPull)]);
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
      clock: () => new Date('2026-10-31T12:00:00.000Z'),
    });
    const [key] = status.due(state, '1-1');
    assert.ok(key !== undefined);
    await status.target.apply(effectKey.encode(key));
    const lines = (created[0] ?? '').split('\n');
    assert.ok(
      lines.includes('- #2 in acme/lib-core: <https://github.com/acme/lib-core/pull/7>, merged'),
      created[0],
    );
    assert.ok(lines.includes('- #3 in acme/web: no pull request yet'), created[0]);
  });

  it('gives an order with one sub-order no sibling section (regression test)', () => {
    const state = fold([
      ordered('1-1', 1),
      {
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [{ issue: 2, repo: lib }],
        dependencies: [],
      },
      ordered('2-1', 2, '1-1'),
      ...opened('2-1', libPull),
    ]);
    assert.equal(siblingSection(state, '2-1'), undefined);
  });

  it('gives a plain order with no plan no sibling section (regression test)', () => {
    const state = fold([ordered('5-1', 5), ...opened('5-1', libPull)]);
    assert.equal(siblingSection(state, '5-1'), undefined);
  });

  it('replaces the old section whole and keeps the rest of the body byte for byte (regression test)', async () => {
    const both = fold([...decomposed, ...opened('2-1', libPull), ...opened('3-1', webPull)]);
    const opening = openedBody('3-1', 3);
    const { host, bodies } = fakeHost({ [libPull]: openedBody('2-1', 2), [webPull]: opening });
    const effects = siblingEffects({ host });
    const settled = await pass(effects, both, ['2-1', '3-1']);
    await pass(effects, fold([merged('2-1', libPull)], settled), ['3-1']);
    const body = bodies[webPull] ?? '';
    assert.equal(body.split('## Pull requests of this order').length, 2, body);
    assert.match(body, /acme\/lib-core#7: merged/);
    assert.doesNotMatch(body, /acme\/lib-core#7: open/);
    // Below the section, the opened body as it was, up to its marker.
    const rest = body.slice(body.indexOf('<!-- foedrum:siblings -->\n\n') + 27);
    const above = (text: string) => text.slice(0, text.lastIndexOf('\n\n<!-- foedrum:['));
    assert.equal(above(rest), above(opening));
  });

  it('asks for no revision once the section it recorded is the one it would write (regression test)', async () => {
    const both = fold([...decomposed, ...opened('2-1', libPull), ...opened('3-1', webPull)]);
    const { host } = fakeHost({ [libPull]: openedBody('2-1', 2), [webPull]: openedBody('3-1', 3) });
    const effects = siblingEffects({ host });
    const settled = await pass(effects, both, ['2-1', '3-1']);
    assert.equal(settled.effects.size, both.effects.size + 2);
    assert.deepEqual(effects.due(settled, '2-1'), []);
    assert.deepEqual(effects.due(settled, '3-1'), []);
  });

  it('keeps room in every body for the longest sibling section (regression test)', () => {
    const state = fold([...decomposed, ...opened('2-1', libPull)]);
    const section = siblingSection(state, '3-1') ?? assert.fail('no section');
    const cell = 'x'.repeat(190);
    const { body } = pullRequestText({
      title: 'Order',
      closes: { repo: brewery, issue: 3 },
      reports: [
        {
          stepId: 'build',
          summary: 'y'.repeat(100_000),
          assumptions: [],
          sections: {
            beforeAfter: Array.from({ length: 70 }, () => ({
              case: cell,
              before: cell,
              after: cell,
            })),
          },
        },
      ],
      key: pullRequestKey('3-1'),
      siblings: section,
    });
    // A later revision may write the longest section in place of this one, within GitHub's limit.
    assert.ok(body.length - section.length + MAX_SIBLINGS <= 65_536, String(body.length));
  });

  it('cuts a section of many sub-orders to its room, counting the rest (regression test)', () => {
    const many = Array.from({ length: 100 }, (_, at) => ({
      issue: 10 + at,
      repo: `acme/${'r'.repeat(90)}${at}`,
    }));
    const state = fold([
      ordered('1-1', 1),
      { type: 'order.decomposed', batchId: '1-1', subOrders: many, dependencies: [] },
      ordered('10-1', 10, '1-1'),
    ]);
    const section = siblingSection(state, '10-1') ?? assert.fail('no section');
    assert.ok(section.length <= MAX_SIBLINGS, String(section.length));
    assert.match(
      section,
      /\nAnd \d+ more pull requests of this order\.\n<!-- foedrum:siblings -->$/,
    );
  });

  it('leaves out a cancelled sub-order, and gives a cancelled one no section (regression test)', () => {
    const three: Event = {
      type: 'order.decomposed',
      batchId: '1-1',
      subOrders: [
        { issue: 2, repo: lib },
        { issue: 3, repo: web },
        { issue: 4, repo: 'acme/cli' },
      ],
      dependencies: [],
    };
    const two: Event = {
      ...three,
      subOrders: [
        { issue: 2, repo: lib },
        { issue: 3, repo: web },
      ],
    };
    const state = fold([
      ordered('1-1', 1),
      three,
      ordered('4-1', 4, '1-1'),
      two,
      ordered('2-1', 2, '1-1'),
    ]);
    assert.doesNotMatch(siblingSection(state, '2-1') ?? assert.fail('no section'), /acme\/cli/);
    assert.equal(siblingSection(state, '4-1'), undefined);
  });

  it("gives a claimed issue's batch no section, though its number is a sub-order's (regression test)", () => {
    const state = fold([
      ...decomposed,
      { type: 'batch.ordered', batchId: '9-1', order: { issue: 2, repo: lib }, routeBy },
    ]);
    assert.notEqual(siblingSection(state, '2-1'), undefined);
    assert.equal(siblingSection(state, '9-1'), undefined);
  });

  it("keeps the plan's order where no dependency orders sub-orders (regression test)", () => {
    const state = fold([
      ordered('1-1', 1),
      {
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [
          { issue: 3, repo: web },
          { issue: 2, repo: lib },
          { issue: 4, repo: 'acme/cli' },
        ],
        dependencies: [],
      },
    ]);
    assert.deepEqual(
      subOrderPullRequests(state, 1).map(({ subOrder }) => subOrder),
      [3, 2, 4],
    );
  });

  it('places a sub-order whose blocker the latest breakdown cancelled, in the plan order (regression test)', () => {
    const first: Event = {
      type: 'order.decomposed',
      batchId: '1-1',
      subOrders: [
        { issue: 3, repo: web },
        { issue: 4, repo: 'acme/cli' },
        { issue: 2, repo: lib },
      ],
      dependencies: [{ subOrder: 3, blockedBy: 4, kind: 'code' }],
    };
    const again: Event = {
      ...first,
      subOrders: [
        { issue: 3, repo: web },
        { issue: 2, repo: lib },
      ],
      dependencies: [{ subOrder: 3, blockedBy: 4, kind: 'code' }],
    };
    const state = fold([ordered('1-1', 1), first, again]);
    assert.deepEqual(
      subOrderPullRequests(state, 1).map(({ subOrder }) => subOrder),
      [3, 2],
    );
  });

  it('asks for no revision of a pull request closed without merging (regression test)', async () => {
    const both = fold([...decomposed, ...opened('2-1', libPull), ...opened('3-1', webPull)]);
    const { host, updates } = fakeHost({
      [libPull]: openedBody('2-1', 2),
      [webPull]: openedBody('3-1', 3),
    });
    const closed = fold(
      [{ type: 'pull_request.ended', batchId: '2-1', pullRequest: libPull, state: 'closed' }],
      both,
    );
    const effects = siblingEffects({ host });
    assert.deepEqual(effects.due(closed, '2-1'), []);
    await pass(effects, closed, ['2-1', '3-1']);
    assert.deepEqual(
      updates.map(({ url }) => url),
      [webPull],
    );
  });

  it("names five of a line's blockers and counts the rest (regression test)", () => {
    const others = [2, 3, 4, 5, 6, 7];
    const state = fold([
      ordered('1-1', 1),
      {
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [
          ...others.map((issue) => ({ issue, repo: `acme/lib${issue}` })),
          { issue: 8, repo: web },
        ],
        dependencies: others.map((blockedBy) => ({
          subOrder: 8,
          blockedBy,
          kind: 'code' as const,
        })),
      },
      ordered('8-1', 8, '1-1'),
    ]);
    const own = (siblingSection(state, '8-1') ?? '')
      .split('\n')
      .find((line) => line.startsWith('7. '));
    assert.equal(
      own,
      '7. This pull request, in acme/web: merge after acme/lib2 merges and acme/lib3 merges and acme/lib4 merges and acme/lib5 merges and acme/lib6 merges and 1 more.',
    );
  });

  it('words a code dependency, no dependency and a closed sibling (regression test)', () => {
    const split = (dependencies: Extract<Event, { type: 'order.decomposed' }>['dependencies']) =>
      fold([
        ordered('1-1', 1),
        {
          type: 'order.decomposed',
          batchId: '1-1',
          subOrders: [
            { issue: 2, repo: lib },
            { issue: 3, repo: web },
          ],
          dependencies,
        },
        ordered('2-1', 2, '1-1'),
        ordered('3-1', 3, '1-1'),
        ...opened('2-1', libPull),
        { type: 'pull_request.ended', batchId: '2-1', pullRequest: libPull, state: 'closed' },
      ]);
    const lines = (state: State) => (siblingSection(state, '3-1') ?? '').split('\n').slice(2, 4);
    assert.deepEqual(lines(split([{ subOrder: 3, blockedBy: 2, kind: 'code' }])), [
      '1. acme/lib-core#7: closed without merging, merge first (this pull request waits for its merge).',
      '2. This pull request, in acme/web: merge after acme/lib-core#7 merges.',
    ]);
    assert.deepEqual(lines(split([])), [
      '1. acme/lib-core#7: closed without merging, merge in any order.',
      '2. This pull request, in acme/web: merge in any order.',
    ]);
  });
});
