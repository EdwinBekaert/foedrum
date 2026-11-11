// How `foedrum status` and `foedrum stuck` describe a batch's state: what it does or waits for.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeState, formatOrderStatus, formatStatus, statusRow } from '../../src/cli/status.ts';
import { batchState } from '../../src/engine/batch-state.ts';
import { type Batch, emptyState, type State } from '../../src/engine/fold.ts';

describe('describeState', () => {
  it('says which pull request failed its checks, on which head, after how many rounds (ADR 0219)', () => {
    const batch: Batch = {
      id: '12-1',
      issue: 12,
      steps: new Map(),
      rewinds: [],
      lane: {
        kind: 'stuck',
        reason: {
          kind: 'pull_request_failed',
          stepId: 'open-pull-request',
          pullRequest: 'https://github.com/acme/api/pull/12',
          head: 'c'.repeat(40),
          rounds: 2,
          failed: [{ name: 'ci / test', conclusion: 'failure' }],
          more: 0,
        },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt: '2026-10-17T12:00:00.000Z',
      },
    };
    assert.deepStrictEqual(describeState(batch, batchState(batch), '12'), {
      state: 'Waiting for you: look at a failure Foedrum could not get past',
      detail: `https://github.com/acme/api/pull/12 failed its checks on ${'c'.repeat(8)} after 2 rounds of fixes by step open-pull-request`,
    });
  });

  it('says which reviews asked for changes past the rounds, and how many more (ADR 0382): regression test', () => {
    const batch: Batch = {
      id: '12-1',
      issue: 12,
      steps: new Map(),
      rewinds: [],
      lane: {
        kind: 'stuck',
        reason: {
          kind: 'pull_request_failed',
          stepId: 'open-pull-request',
          pullRequest: 'https://github.com/acme/api/pull/12',
          head: 'c'.repeat(40),
          rounds: 2,
          failed: [],
          more: 0,
          cause: { kind: 'review', reviews: [{ id: 81, by: 'ada' }], more: 2 },
        },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt: '2026-10-17T12:00:00.000Z',
      },
    };
    assert.deepStrictEqual(describeLane(batch, '12'), {
      lane: 'stuck',
      detail: `https://github.com/acme/api/pull/12 got changes asked for on ${'c'.repeat(40)} at open-pull-request after 2 rounds: review 81 by ada, and 2 more; reminder 2026-10-17T12:00:00.000Z`,
    });
  });

  it('says which pull request fails its checks on the merged tree, with which base and check (ADR 0226)', () => {
    const batch: Batch = {
      id: '12-1',
      issue: 12,
      steps: new Map(),
      rewinds: [],
      lane: {
        kind: 'stuck',
        reason: {
          kind: 'pull_request_failed',
          stepId: 'open-pull-request',
          pullRequest: 'https://github.com/acme/api/pull/12',
          head: 'c'.repeat(40),
          rounds: 1,
          failed: [],
          more: 0,
          cause: {
            kind: 'merged_check',
            branch: 'main',
            tip: 'e'.repeat(40),
            check: 'the check "test" (npm test)',
          },
        },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt: '2026-10-17T12:00:00.000Z',
      },
    };
    assert.deepStrictEqual(describeState(batch, batchState(batch), '12'), {
      state: 'Waiting for you: look at a failure Foedrum could not get past',
      detail: `https://github.com/acme/api/pull/12 fails its checks once merged with main at ${'e'.repeat(8)}: the check "test" (npm test), after 1 round of fixes by step open-pull-request`,
    });
  });

  it('says which pull request conflicts with its base, at which tip and in which files (ADR 0244)', () => {
    const batch: Batch = {
      id: '12-1',
      issue: 12,
      steps: new Map(),
      rewinds: [],
      lane: {
        kind: 'stuck',
        reason: {
          kind: 'pull_request_failed',
          stepId: 'open-pull-request',
          pullRequest: 'https://github.com/acme/api/pull/12',
          head: 'c'.repeat(40),
          rounds: 2,
          failed: [],
          more: 0,
          cause: {
            kind: 'conflict',
            branch: 'main',
            tip: 'e'.repeat(40),
            files: ['src/a.ts', 'logo.png'],
          },
        },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt: '2026-10-17T12:00:00.000Z',
      },
    };
    assert.deepStrictEqual(describeState(batch, batchState(batch), '12'), {
      state: 'Waiting for you: look at a failure Foedrum could not get past',
      detail: `https://github.com/acme/api/pull/12 conflicts with main at ${'e'.repeat(8)} in src/a.ts, logo.png, after 2 rounds of fixes by step open-pull-request`,
    });
  });
});

describe('foedrum status of a batch on tap, by how its pull requests ended', () => {
  const first = 'https://github.com/acme/api/pull/7';
  const second = 'https://github.com/acme/api/pull/8';
  const onTap = (pullRequests: string[], ends?: Record<string, 'merged' | 'closed'>): Batch => ({
    id: '7-1',
    issue: 7,
    steps: new Map(),
    rewinds: [],
    lane: { kind: 'on_tap', pullRequests },
    ...(ends === undefined ? {} : { pullRequestEnds: ends }),
  });
  const stateOf = (batch: Batch): State => ({
    ...emptyState,
    batches: new Map([[batch.id, batch]]),
  });
  /** The detail cell of the batch's row, whose layout is id, order, state, detail. */
  const detailOf = (batch: Batch): string => statusRow(stateOf(batch), batch)[3] ?? '';
  /** What the detail says between `url` and the next link (or its end). */
  const saidOf = (detail: string, url: string, next?: string): string => {
    const from = detail.indexOf(url);
    assert.notEqual(from, -1, `${url} is in ${detail}`);
    const to = next === undefined ? detail.length : detail.indexOf(next);
    assert.ok(to > from, `${next} follows ${url} in ${detail}`);
    return detail.slice(from + url.length, to);
  };

  it('foedrum status of a batch whose pull request merged says so', () => {
    const batch = onTap([first], { [first]: 'merged' });
    const text = formatStatus(stateOf(batch));
    const row = text.split('\n').find((line) => line.includes('7-1')) ?? '';
    assert.match(row, /^ {2}7-1 +#7 +Done: merged +/);
    assert.ok(row.includes(first), row);
    assert.match(row, /\bmerged\b/);
  });

  it('keeps the four cells of the row, the state done: merged, and the link', () => {
    const batch = onTap([first], { [first]: 'merged' });
    const row = statusRow(stateOf(batch), batch);
    assert.equal(row.length, 4);
    assert.deepStrictEqual(row.slice(0, 3), ['7-1', '#7', 'Done: merged']);
    assert.ok(row[3]?.includes(first), row[3]);
    assert.match(row[3] ?? '', /\bmerged\b/);
  });

  it('says a pull request closed without merging is closed, and not merged', () => {
    const detail = detailOf(onTap([first], { [first]: 'closed' }));
    assert.ok(detail.includes(first), detail);
    assert.match(detail, /\bclosed\b/);
    assert.doesNotMatch(detail, /\bmerged\b/);
  });

  it('says a pull request with no end is still open', () => {
    const detail = detailOf(onTap([first]));
    assert.ok(detail.includes(first), detail);
    assert.match(detail, /\bopen\b/);
    assert.doesNotMatch(detail, /\b(merged|closed|done)\b/i);
  });

  it('says it of each pull request beside its own link', () => {
    const detail = detailOf(onTap([first, second], { [first]: 'closed', [second]: 'merged' }));
    const ofFirst = saidOf(detail, first, second);
    const ofSecond = saidOf(detail, second);
    assert.match(ofFirst, /\bclosed\b/);
    assert.doesNotMatch(ofFirst, /\bmerged\b/);
    assert.match(ofSecond, /\bmerged\b/);
    assert.doesNotMatch(ofSecond, /\bclosed\b/);
  });

  it('says of a batch with one pull request merged and one still open which is which, and not that it is done', () => {
    const detail = detailOf(onTap([first, second], { [first]: 'merged' }));
    assert.match(saidOf(detail, first, second), /\bmerged\b/);
    assert.match(saidOf(detail, second), /\bopen\b/);
    assert.doesNotMatch(detail, /\bdone\b/i);
  });

  it('foedrum status of a batch whose pull requests all merged says merged and not done', () => {
    const detail = detailOf(onTap([first, second], { [first]: 'merged', [second]: 'merged' }));
    assert.match(saidOf(detail, first, second), /merged/);
    assert.match(saidOf(detail, second), /merged/);
    assert.doesNotMatch(detail, /done/i);
  });

  it('says it in the board of an order too', () => {
    const batch = onTap([first], { [first]: 'merged' });
    const text = formatOrderStatus(stateOf(batch), [batch], new Map());
    const row = text.split('\n').find((line) => line.includes('7-1')) ?? '';
    assert.match(row, /^ {2}7-1 +#7 +Done: merged +/);
    assert.match(row, /\bmerged\b/);
  });

  it('keeps the pull request’s link of a batch whose pull request has not ended, and says it waits for review (regression test)', () => {
    const open = onTap([first]);
    assert.deepStrictEqual(describeState(open, batchState(open), '7'), {
      state: 'Waiting for you: review and merge the pull request',
      detail: first,
    });
    const row = statusRow(stateOf(open), open);
    assert.deepStrictEqual(row.slice(0, 3), [
      '7-1',
      '#7',
      'Waiting for you: review and merge the pull request',
    ]);
    assert.ok(row[3]?.startsWith(first), row[3]);
  });

  it('keeps what a plan a person signed off says, with no pull request (regression test)', () => {
    const approval = {
      stepId: 'plan',
      attempt: 1,
      plan: 'a'.repeat(64),
      by: 'ada',
      via: 'terminal',
      at: '2026-11-06T10:00:00.000Z',
    } as const;
    const batch: Batch = { ...onTap([]), approval };
    assert.deepStrictEqual(describeState(batch, batchState(batch), '7'), {
      state: 'Queued: its sub-orders are being opened',
      detail: 'plan approved by ada from a terminal',
    });
  });

  it('says nothing of pull requests for a batch on tap that has none (regression test)', () => {
    const batch = onTap([]);
    assert.deepStrictEqual(statusRow(stateOf(batch), batch), [
      '7-1',
      '#7',
      'Done: finished with no pull request',
      '',
    ]);
  });
});
