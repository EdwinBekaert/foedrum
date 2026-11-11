// `foedrum stuck` and a split order (ADR 0379): the order waits for you through its sub-orders, so
// it is listed itself only when no sub-order it names is listed, as when one is closed without
// merging and keeps the order open.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatStuck } from '../../src/cli/stuck.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { pullRequestKey } from '../../src/engine/pull-request.ts';
import type { Event } from '../../src/schemas/events.ts';

const at = '2026-11-01T12:00:00.000Z';
const routeBy = '2026-11-01T13:00:00.000Z';
const lib = 'https://github.com/acme/lib/pull/8';
const subOrder = (id: string, repo: string) => ({
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
});
/** Order #1, planned by 1-1, approved and split into #2 in acme/lib and #3 in acme/web. */
const split: Event[] = [
  { type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy },
  { type: 'batch.recipe_chosen', batchId: '1-1', recipe: 'mash', reason: 'label', source: 'label' },
  { type: 'step.scheduled', batchId: '1-1', stepId: 'plan', attempt: 1, deadlineAt: routeBy },
  { type: 'step.started', batchId: '1-1', stepId: 'plan', attempt: 1 },
  {
    type: 'step.finished',
    batchId: '1-1',
    stepId: 'plan',
    attempt: 1,
    outcome: {
      kind: 'succeeded',
      output: {
        status: 'done',
        summary: 'A plan',
        assumptions: [],
        subOrders: [subOrder('lib', 'acme/lib'), subOrder('web', 'acme/web')],
      },
    },
  },
  {
    type: 'order.decomposed',
    batchId: '1-1',
    subOrders: [
      { issue: 2, repo: 'acme/lib', entry: 'lib' },
      { issue: 3, repo: 'acme/web', entry: 'web' },
    ],
    dependencies: [],
    plan: { stepId: 'plan', attempt: 1 },
  },
  {
    type: 'batch.approved',
    batchId: '1-1',
    stepId: 'plan',
    attempt: 1,
    plan: '0123456789abcdef',
    by: 'grace',
    via: 'terminal',
    at,
  },
  { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
];
/** Sub-order #2's batch on tap with its pull request open. */
const opened: Event[] = [
  { type: 'batch.ordered', batchId: '2-1', order: { issue: 2 }, parentBatchId: '1-1', routeBy },
  { type: 'effect.applied', key: effectKey.encode(pullRequestKey('2-1')), result: lib },
  { type: 'batch.on_tap', batchId: '2-1', pullRequests: [lib] },
];

describe('foedrum stuck and a split order', () => {
  it('lists the sub-order that waits for your review, not its order too: regression test', () => {
    assert.equal(
      formatStuck(fold([...split, ...opened])),
      [
        '1 batch waits for you',
        '',
        `2-1  #2  Waiting for you: review and merge the pull request: ${lib}`,
        `  Next: review and merge ${lib}.`,
        '',
      ].join('\n'),
    );
  });

  it('lists the order when a sub-order closed without merging keeps it open, with its Next line', () => {
    const closed: Event[] = [
      ...opened,
      { type: 'pull_request.ended', batchId: '2-1', pullRequest: lib, state: 'closed' },
    ];
    assert.equal(
      formatStuck(fold([...split, ...closed])),
      [
        '1 batch waits for you',
        '',
        '1-1  #1  Waiting for you: look at sub-order #2, closed without merging: plan approved by grace from a terminal',
        '  Next: see to what keeps the order open (#2).',
        '',
      ].join('\n'),
    );
  });
});
