// How `foedrum status` and `foedrum brew` describe a batch's lane (status.ts): a batch that waits for
// a session names the command that opens it (ADR 0222).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeLane } from '../../src/cli/status.ts';
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

describe('describeLane: a batch waiting for a session (ADR 0222)', () => {
  it('names foedrum brew with --take, to run in a terminal', () => {
    assert.deepStrictEqual(describeLane(waiting()), {
      lane: 'stuck',
      detail: `waiting for a session at refine: foedrum brew 7 --take opens it in a terminal; reminder ${remindAt}`,
    });
  });

  it("names a target issue's order by its repository, whose alias foedrum.jsonc gives", () => {
    const { detail } = describeLane(waiting({ repo: 'acme/api' }));
    assert.match(detail, /foedrum brew <alias of acme\/api>#7 --take opens it in a terminal/);
  });
});
