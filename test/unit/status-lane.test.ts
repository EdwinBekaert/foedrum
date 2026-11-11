// How `foedrum status` and `foedrum brew` describe a batch's lane (status.ts): a batch that waits for
// a session names the command that opens it (ADR 0222).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeState } from '../../src/cli/status.ts';
import { batchState } from '../../src/engine/batch-state.ts';
import type { Batch } from '../../src/engine/fold.ts';

const remindAt = '2026-10-18T09:00:00.000Z';
const waiting = (fields: Partial<Batch> = {}): Batch => ({
  id: '7-1',
  issue: 7,
  recipe: { name: 'lauter', reason: 'label', source: 'label' },
  lane: {
    kind: 'stuck',
    reason: { kind: 'waiting_for_session', stepId: 'refine' },
    options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
    remindAt,
  },
  steps: new Map(),
  rewinds: [],
  ...fields,
});

describe('describeState: a batch waiting for a session (ADR 0222)', () => {
  it('names foedrum brew with --take, to run in a terminal', () => {
    const batch = waiting();
    assert.deepStrictEqual(describeState(batch, batchState(batch), '7'), {
      state: 'Waiting for you: open its session',
      detail:
        'step refine is done by a person in a session: foedrum brew 7 --take opens it in a terminal',
    });
  });

  it("names a target issue's order by what its caller reads from the fold (ADR 0329)", () => {
    const batch = waiting({ repo: 'acme/api' });
    const { detail } = describeState(batch, batchState(batch), '40');
    assert.match(detail, /foedrum brew 40 --take opens it in a terminal/);
  });
});
