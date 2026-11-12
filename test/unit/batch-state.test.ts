// What a person reads a batch as (ADR 0385): running, waiting for you, queued or done, the same in
// `foedrum status` and the status comment.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { statusRow } from '../../src/cli/status.ts';
import { type Batch, emptyState, type Lane, type State } from '../../src/engine/fold.ts';
import type { SubOrderRow } from '../../src/engine/order-end.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';

const at = '2026-11-12T12:00:00.000Z';
const lib = 'https://github.com/acme/lib/pull/4';
const web = 'https://github.com/acme/web/pull/7';

const batch = (lane: Lane, fields: Partial<Batch> = {}): Batch => ({
  id: '1-1',
  issue: 1,
  recipe: { name: 'nip', reason: 'label', source: 'label' },
  lane,
  steps: new Map(),
  rewinds: [],
  ...fields,
});
const stateOf = (one: Batch): State => ({ ...emptyState, batches: new Map([[one.id, one]]) });
/** The state and what follows it in `foedrum status`. */
const statusOf = (one: Batch): string[] => statusRow(stateOf(one), one).slice(2);
/** The status comment's first block, the state's. */
const stateBlockOf = (one: Batch, rows: readonly SubOrderRow[] = []): string[] =>
  (
    renderStatus(
      one,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      rows,
    ).split('\n\n')[1] ?? ''
  ).split('\n');
const planReview: Lane = {
  kind: 'stuck',
  reason: { kind: 'plan_review', stepId: 'plan', attempt: 1 },
  options: ['approve', 'lauter', 'retry', 'cancel'],
  remindAt: at,
};
const approval = {
  stepId: 'plan',
  attempt: 1,
  plan: 'a'.repeat(64),
  by: 'ann',
  via: 'terminal',
  at,
} as const;

describe('the state a person reads a batch as (ADR 0385)', () => {
  it('a plan waiting for review reads waiting for you in foedrum status', () => {
    assert.deepEqual(statusOf(batch(planReview)), ['waiting for you', 'approve the plan']);
  });

  it('a batch whose pull requests all merged reads done in foedrum status', () => {
    const merged = batch(
      { kind: 'on_tap', pullRequests: [lib, web] },
      { pullRequestEnds: { [lib]: 'merged', [web]: 'merged' } },
    );
    assert.deepEqual(statusOf(merged), ['done', `merged: ${lib} ${web}`]);
  });

  it('the status comment shows one done line when every sub-order merged', () => {
    const split = batch({ kind: 'on_tap', pullRequests: [] }, { approval, decomposed: true });
    const rows: SubOrderRow[] = [
      { subOrder: 2, repo: 'acme/lib', pullRequest: lib, state: 'merged' },
      { subOrder: 3, repo: 'acme/web', pullRequest: web, state: 'merged' },
    ];
    const block = stateBlockOf(split, rows);
    assert.deepEqual(
      block.filter((line) => /\*\*/.test(line)),
      ['🍻 **Done**: every sub-order merged'],
    );
  });

  it('the status comment and foedrum status show the same state for a batch', () => {
    const lanes: Batch[] = [
      batch({ kind: 'ordered', routeBy: at }),
      batch({ kind: 'brewing' }),
      batch({ kind: 'conditioning', on: { kind: 'sibling', batchId: '2-1' }, remindAt: at }),
      batch(planReview),
      batch({ kind: 'on_tap', pullRequests: [lib] }),
      batch({ kind: 'on_tap', pullRequests: [lib] }, { pullRequestEnds: { [lib]: 'closed' } }),
      batch({ kind: 'cancelled', by: 'ann', via: 'terminal' }),
    ];
    const words = ['running', 'waiting for you', 'queued', 'done'];
    for (const one of lanes) {
      const [shown] = statusOf(one);
      const head = stateBlockOf(one)[0]
        ?.match(/\*\*(.+?)\*\*/)?.[1]
        ?.toLowerCase();
      assert.ok(words.includes(shown ?? ''), `${one.lane.kind}: ${shown}`);
      assert.equal(head, shown, one.lane.kind);
    }
  });

  it('a cancelled batch reads done, cancelled', () => {
    const cancelled = batch({ kind: 'cancelled', by: 'ann', via: 'terminal' });
    assert.deepEqual(statusOf(cancelled), ['done', 'cancelled by ann via terminal']);
    assert.equal(stateBlockOf(cancelled)[0], '🚫 **Done**: cancelled by ann (terminal)');
  });
});
