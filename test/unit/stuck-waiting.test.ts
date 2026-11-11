// `foedrum stuck` lists every batch that waits for you (ADR 0379): a Stuck one, and one whose pull
// request waits for your review and merge, each with its Next line; a batch that waits for no one is
// left out.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatStuck } from '../../src/cli/stuck.ts';
import { type Batch, emptyState, type State } from '../../src/engine/fold.ts';

const pr = 'https://github.com/alice/web/pull/12';

const batch = (id: string, issue: number, lane: Batch['lane'], fields: Partial<Batch> = {}) =>
  ({ id, issue, lane, steps: new Map(), rewinds: [], ...fields }) satisfies Batch;
const stateOf = (...batches: readonly Batch[]): State => ({
  ...emptyState,
  batches: new Map(batches.map((one) => [one.id, one])),
});

describe('foedrum stuck', () => {
  it('lists a batch whose pull request waits for your review and merge, with its Next line', () => {
    const text = formatStuck(stateOf(batch('1-1', 1, { kind: 'on_tap', pullRequests: [pr] })));
    assert.equal(
      text,
      [
        '1 batch waits for you',
        '',
        `1-1  #1  Waiting for you: review and merge the pull request: ${pr}`,
        `  Next: review and merge ${pr}.`,
        '',
      ].join('\n'),
    );
  });

  it('leaves out a batch that waits for no one: one running, one done', () => {
    const done = batch(
      '2-1',
      2,
      { kind: 'on_tap', pullRequests: [pr] },
      {
        pullRequestEnds: { [pr]: 'merged' },
      },
    );
    assert.equal(
      formatStuck(stateOf(batch('1-1', 1, { kind: 'brewing' }), done)),
      'Nothing waits for you.\n',
    );
  });
});
