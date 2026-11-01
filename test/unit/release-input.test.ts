// The `release` input of a sub-order's batch (ADR 0291): the release that made it ready, its tag as
// recorded, with the blocker's merged pull request. Recorded events folded, no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const lib = 'acme/lib';
const web = 'acme/web';
const routeBy = '2026-11-01T13:00:00.000Z';
const pr = (n: number): string => `https://github.com/acme/lib/pull/${n}`;

const ordered = (batchId: string, issue: number, parentBatchId?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue },
  ...(parentBatchId === undefined ? {} : { parentBatchId }),
  routeBy,
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
describe('releaseInput', () => {
  it('folds and reads a release recorded before releases had a page or notes the same: regression test', () => {
    const old: Event = { type: 'release.observed', repo: lib, package: 'lib', version: 'v1.4.0' };
    const state = fold([...merged(), old]);
    assert.deepStrictEqual(state.releases, [
      { repo: lib, package: 'lib', version: 'v1.4.0', seq: 2 },
    ]);
  });
});
