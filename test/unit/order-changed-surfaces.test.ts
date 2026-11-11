// A batch whose issue changed after its approval asks the engineer (ADR 0368) through the surfaces a
// question already uses: `foedrum stuck`, `foedrum status`, the status comment, and `foedrum answer`
// with continue or stop; each says what changed and links the issue.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeLane } from '../../src/cli/status.ts';
import { formatStuck } from '../../src/cli/stuck.ts';
import { batchState } from '../../src/engine/batch-state.ts';
import { type Batch, emptyState, type State } from '../../src/engine/fold.ts';
import { stateLabel } from '../../src/engine/lane-labels.ts';
import { ORDER_CHANGED_QUESTION } from '../../src/engine/order-changes.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';

const changed: Batch = {
  id: 'app-7',
  issue: 7,
  repo: 'acme/app',
  lane: {
    kind: 'stuck',
    reason: {
      kind: 'order_changed',
      stepId: 'plan',
      changes: [
        { what: 'title', by: 'stranger', at: '2026-11-10T11:00:00Z' },
        { what: 'comment', comment: 501, at: '2026-11-10T11:30:00Z' },
      ],
      more: 2,
      upTo: '2026-11-10T11:30:00Z',
    },
    options: ['answer', 'cancel'],
    remindAt: '2026-11-12T12:00:00.000Z',
  },
  steps: new Map(),
  rewinds: [],
};
const stateOf = (batch: Batch): State => ({
  ...emptyState,
  batches: new Map([[batch.id, batch]]),
});
const what =
  'the title by stranger at 2026-11-10T11:00:00Z, comment 501 by a deleted account at 2026-11-10T11:30:00Z and 2 more';

describe('an order that changed after its approval, as people see it (ADR 0368)', () => {
  it('foedrum stuck says what changed, links the issue and asks continue or stop', () => {
    const text = formatStuck(stateOf(changed));
    assert.ok(text.includes(`acme/app#7 changed after its approval: ${what}`), text);
    assert.ok(text.includes('https://github.com/acme/app/issues/7'), text);
    assert.ok(text.includes(`  1. ${ORDER_CHANGED_QUESTION} (continue, stop)`), text);
    assert.ok(text.includes('  options: answer, cancel'), text);
  });

  it('foedrum status says it on the batch line', () => {
    const { detail } = describeLane(changed, 'app-7');
    assert.equal(
      detail,
      `the order changed at plan: acme/app#7 changed after its approval: ${what}; reminder 2026-11-12T12:00:00.000Z`,
    );
  });

  it('the status comment says it, links the issue and names the answers', () => {
    const text = renderStatus(changed);
    assert.ok(
      text.includes(
        `${'`plan`'} waits for you: [acme/app\\#7](<https://github.com/acme/app/issues/7>) changed after its approval: ${what}. Run ${'`foedrum answer 7 continue`'} to brew it as it is now, or ${'`foedrum answer 7 stop`'} to end the batch`,
      ),
      text,
    );
  });

  it("the status comment's Next: line names continue and stop", () => {
    const text = renderStatus(changed);
    const next = text.split('\n').find((line) => line.startsWith('Next:'));
    assert.equal(
      next,
      `Next: answer with ${'`foedrum answer 7 continue`'} to brew the issue as it is now, or ${'`foedrum answer 7 stop`'} to end the batch.`,
    );
  });

  it('carries the label of a batch that waits for an answer', () => {
    assert.equal(stateLabel(batchState(changed)), 'foedrum:answer');
  });
});
