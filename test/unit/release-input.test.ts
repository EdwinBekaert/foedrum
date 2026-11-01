// The `release` input of a sub-order's batch (ADR 0291): the release that made it ready, its tag as
// recorded, with the blocker's merged pull request. Recorded events folded, no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold } from '../../src/engine/fold.ts';
import { releaseInput } from '../../src/engine/release-input.ts';
import type { Event } from '../../src/schemas/events.ts';

const lib = 'acme/lib';
const web = 'acme/web';
const routeBy = '2026-11-01T13:00:00.000Z';
const pr = (n: number): string => `https://github.com/acme/lib/pull/${n}`;
const releasePage = (tag: string): string => `https://github.com/acme/lib/releases/tag/${tag}`;

const ordered = (batchId: string, issue: number, parentBatchId?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue },
  ...(parentBatchId === undefined ? {} : { parentBatchId }),
  routeBy,
});
const released = (version: string, fields: { url?: string; notes?: string } = {}): Event => ({
  type: 'release.observed',
  repo: lib,
  package: 'lib',
  version,
  ...fields,
});
/** Order #1: #3 in acme/web waits on #2 in acme/lib by `kind`; #2's pull request 5 merged. */
const merged = (kind: 'code' | 'release' = 'release'): Event[] => [
  ordered('1-1', 1),
  {
    type: 'order.decomposed',
    batchId: '1-1',
    subOrders: [
      { issue: 2, repo: lib },
      { issue: 3, repo: web },
    ],
    dependencies: [{ subOrder: 3, blockedBy: 2, kind }],
  },
  { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
  ordered('2-1', 2, '1-1'),
  { type: 'batch.on_tap', batchId: '2-1', pullRequests: [pr(5)] },
  { type: 'pull_request.ended', batchId: '2-1', pullRequest: pr(5), state: 'merged' },
];
const inputOf = (events: Event[], batchId = '3-1') => {
  const state = fold(events);
  const batch = state.batches.get(batchId);
  assert.ok(batch);
  return releaseInput(state, batch);
};

describe('releaseInput', () => {
  it("gives a release-blocked sub-order's batch the release that made it ready, with the blocker's merged pull request", () => {
    const events = [
      ...merged(),
      released('v1.4.0', { url: releasePage('v1.4.0'), notes: '## Features\n\n- A faster parser' }),
      ordered('3-1', 3, '1-1'),
    ];
    assert.deepStrictEqual(inputOf(events), {
      releases: [{ repo: lib, version: 'v1.4.0' }],
      text: [
        `#### The release of ${lib} that #3 waited for`,
        '- Tag, as written: v1.4.0',
        `- Release: ${releasePage('v1.4.0')}`,
        `- Merged pull request of #2: ${pr(5)}`,
        '- Notes:',
        '',
        '## Features',
        '',
        '- A faster parser',
      ].join('\n'),
    });
  });

  it('carries the tag exactly as recorded, with no version parsed out of it, and says a bare tag has no notes', () => {
    const input = inputOf([...merged(), released('lib@1.4.0'), ordered('3-1', 3, '1-1')]);
    assert.deepStrictEqual(input?.releases, [{ repo: lib, version: 'lib@1.4.0' }]);
    assert.equal(
      input?.text,
      [
        `#### The release of ${lib} that #3 waited for`,
        '- Tag, as written: lib@1.4.0',
        '- A tag with no release on the code host: no release page, no notes',
        `- Merged pull request of #2: ${pr(5)}`,
      ].join('\n'),
    );
  });

  it('gives the release that made the batch ready when the repository has two releases after the merge', () => {
    // v1.3.0 came before the merge and holds none of it; v1.4.0 unblocked #3, v1.5.0 came later.
    const [first, ...rest] = merged();
    assert.ok(first);
    const events = [
      first,
      ...rest.slice(0, -1),
      released('v1.3.0'),
      ...rest.slice(-1),
      released('v1.4.0'),
      released('v1.5.0'),
      ordered('3-1', 3, '1-1'),
    ];
    assert.deepStrictEqual(inputOf(events)?.releases, [{ repo: lib, version: 'v1.4.0' }]);
  });

  it('has no release input for a batch whose sub-order waits on no release, nor for an order', () => {
    const coded = [...merged('code'), released('v1.4.0'), ordered('3-1', 3, '1-1')];
    assert.equal(inputOf(coded), undefined);
    assert.equal(inputOf([...merged(), released('v1.4.0')], '1-1'), undefined);
  });

  it('leaves out the lines of the notes that look like secrets, and says how many', () => {
    // Built at run time, so the repository holds no secret-shaped text.
    const token = `ghp_${'A1b2'.repeat(9)}`;
    const notes = ['## Fixes', `- Rotated ${token}`, '- A faster parser', `token: ${token}`].join(
      '\n',
    );
    const input = inputOf([
      ...merged(),
      released('v1.4.0', { url: releasePage('v1.4.0'), notes }),
      ordered('3-1', 3, '1-1'),
    ]);
    assert.ok(input);
    assert.ok(!input.text.includes(token));
    assert.match(
      input.text,
      /\n- Notes:\n\n## Fixes\n- A faster parser\n\n\(2 lines of the notes left out: they looked like secrets\)$/,
    );
  });

  it('gives no release input to a sibling sub-order that waits on no release, while #3 waits on one: regression test', () => {
    const events: Event[] = [
      ordered('1-1', 1),
      {
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [
          { issue: 2, repo: lib },
          { issue: 3, repo: web },
          { issue: 4, repo: web },
        ],
        dependencies: [{ subOrder: 3, blockedBy: 2, kind: 'release' }],
      },
      ...merged().slice(2),
      released('v1.4.0'),
      ordered('3-1', 3, '1-1'),
      ordered('4-1', 4, '1-1'),
    ];
    assert.deepStrictEqual(inputOf(events)?.releases, [{ repo: lib, version: 'v1.4.0' }]);
    assert.equal(inputOf(events, '4-1'), undefined);
  });

  it('gives one section per release blocker, in the order the breakdown names them: regression test', () => {
    const core = 'acme/core';
    const corePr = 'https://github.com/acme/core/pull/6';
    const events: Event[] = [
      ordered('1-1', 1),
      {
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [
          { issue: 2, repo: lib },
          { issue: 3, repo: web },
          { issue: 4, repo: core },
        ],
        dependencies: [
          { subOrder: 3, blockedBy: 2, kind: 'release' },
          { subOrder: 3, blockedBy: 4, kind: 'release' },
        ],
      },
      ...merged().slice(2),
      ordered('4-1', 4, '1-1'),
      { type: 'batch.on_tap', batchId: '4-1', pullRequests: [corePr] },
      { type: 'pull_request.ended', batchId: '4-1', pullRequest: corePr, state: 'merged' },
      // Recorded in the other order than the breakdown names the blockers.
      { type: 'release.observed', repo: core, package: 'core', version: 'v2.0.0' },
      released('v1.4.0'),
      ordered('3-1', 3, '1-1'),
    ];
    const input = inputOf(events);
    assert.deepStrictEqual(input?.releases, [
      { repo: lib, version: 'v1.4.0' },
      { repo: core, version: 'v2.0.0' },
    ]);
    assert.match(
      input?.text ?? '',
      /pull\/5\n\n#### The release of acme\/core that #3 waited for\n- Tag, as written: v2\.0\.0\n/,
    );
  });

  it("names only the blocker's pull requests merged before the release: regression test", () => {
    const events: Event[] = [
      ...merged(),
      released('v1.4.0'),
      ordered('2-2', 2, '1-1'),
      { type: 'batch.on_tap', batchId: '2-2', pullRequests: [pr(7)] },
      { type: 'pull_request.ended', batchId: '2-2', pullRequest: pr(7), state: 'merged' },
      ordered('3-1', 3, '1-1'),
    ];
    const text = inputOf(events)?.text ?? '';
    assert.match(text, /- Merged pull request of #2: https:\/\/github\.com\/acme\/lib\/pull\/5$/);
    assert.ok(!text.includes(pr(7)));
  });

  it('says one line of the notes was left out when one was: regression test', () => {
    const token = `ghp_${'A1b2'.repeat(9)}`;
    const input = inputOf([
      ...merged(),
      released('v1.4.0', { url: releasePage('v1.4.0'), notes: `- A faster parser\n${token}` }),
      ordered('3-1', 3, '1-1'),
    ]);
    assert.match(
      input?.text ?? '',
      /\n- A faster parser\n\n\(1 line of the notes left out: they looked like secrets\)$/,
    );
  });

  it('folds a release recorded before releases had a page or notes as before: regression test', () => {
    const old: Event = { type: 'release.observed', repo: lib, package: 'lib', version: 'v1.4.0' };
    const state = fold([...merged(), old]);
    assert.deepStrictEqual(state.releases, [
      { repo: lib, package: 'lib', version: 'v1.4.0', seq: 2 },
    ]);
  });
});
