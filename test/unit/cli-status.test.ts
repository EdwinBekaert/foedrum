// How `foedrum status` and `foedrum stuck` describe a batch's lane: what it does or waits for.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeLane, formatOrderStatus, formatStatus, statusRow } from '../../src/cli/status.ts';
import { type Batch, emptyState, type State } from '../../src/engine/fold.ts';

describe('describeLane', () => {
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
    assert.deepStrictEqual(describeLane(batch, '12'), {
      lane: 'stuck',
      detail: `https://github.com/acme/api/pull/12 failed its checks on ${'c'.repeat(40)} at open-pull-request after 2 rounds; reminder 2026-10-17 12:00 UTC`,
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
      detail: `https://github.com/acme/api/pull/12 got changes asked for on ${'c'.repeat(40)} at open-pull-request after 2 rounds: review 81 by ada, and 2 more; reminder 2026-10-17 12:00 UTC`,
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
    assert.deepStrictEqual(describeLane(batch, '12'), {
      lane: 'stuck',
      detail: `https://github.com/acme/api/pull/12 fails its checks on the merged tree with main at ${'e'.repeat(40)}: the check "test" (npm test), at open-pull-request after 1 round; reminder 2026-10-17 12:00 UTC`,
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
    assert.deepStrictEqual(describeLane(batch, '12'), {
      lane: 'stuck',
      detail: `https://github.com/acme/api/pull/12 conflicts with main at ${'e'.repeat(40)} in src/a.ts, logo.png, at open-pull-request after 2 rounds; reminder 2026-10-17 12:00 UTC`,
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

  it('foedrum status of a batch whose pull request merged says so', () => {
    const batch = onTap([first], { [first]: 'merged' });
    const text = formatStatus(stateOf(batch));
    const row = text.split('\n').find((line) => line.includes('7-1')) ?? '';
    assert.match(row, /^ {2}7-1 +#7 +done +/);
    assert.ok(row.includes(first), row);
    assert.match(row, /\bmerged\b/);
  });

  it('keeps the four cells of the row, the state done, and the link', () => {
    const batch = onTap([first], { [first]: 'merged' });
    const row = statusRow(stateOf(batch), batch);
    assert.equal(row.length, 4);
    assert.deepStrictEqual(row.slice(0, 3), ['7-1', '#7', 'done']);
    assert.ok(row[3]?.includes(first), row[3]);
    assert.match(row[3] ?? '', /\bmerged\b/);
  });

  it('says a pull request closed without merging is closed, and not merged', () => {
    const detail = detailOf(onTap([first], { [first]: 'closed' }));
    assert.ok(detail.includes(first), detail);
    assert.match(detail, /\bclosed\b/);
    assert.doesNotMatch(detail, /\bmerged\b/);
  });

  it('says a pull request with no end waits for you to merge it', () => {
    const detail = detailOf(onTap([first]));
    assert.ok(detail.includes(first), detail);
    assert.match(detail, /^merge a pull request: /);
    assert.doesNotMatch(detail, /\b(merged|closed|done)\b/i);
  });

  it('says how each pull request ended, before its own link', () => {
    const detail = detailOf(onTap([first, second], { [first]: 'closed', [second]: 'merged' }));
    assert.equal(detail, `merged: ${second}; closed without merging: ${first}`);
  });

  it('says of a batch with one pull request merged and one still open which is which, and not that it is done', () => {
    const detail = detailOf(onTap([first, second], { [first]: 'merged' }));
    assert.equal(detail, `merge a pull request: ${second}; merged: ${first}`);
    assert.doesNotMatch(detail, /\bdone\b/i);
  });

  it('says it in the board of an order too', () => {
    const batch = onTap([first], { [first]: 'merged' });
    const text = formatOrderStatus(stateOf(batch), [batch], new Map());
    const row = text.split('\n').find((line) => line.includes('7-1')) ?? '';
    assert.match(row, /^ {2}7-1 +#7 +done +/);
    assert.match(row, /\bmerged\b/);
  });

  it('keeps the pull request’s link, waiting for you, of a batch whose pull request has not ended', () => {
    assert.deepStrictEqual(describeLane(onTap([first]), '7'), { lane: 'on tap', detail: first });
    const open = onTap([first]);
    const row = statusRow(stateOf(open), open);
    assert.deepStrictEqual(row.slice(0, 3), ['7-1', '#7', 'waiting for you']);
    assert.equal(row[3], `merge a pull request: ${first}`);
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
    assert.deepStrictEqual(describeLane(batch, '7'), {
      lane: 'on tap',
      detail: 'plan approved by ada via terminal',
    });
  });

  it('says a batch on tap that has no pull request is done with none', () => {
    const batch = onTap([]);
    assert.deepStrictEqual(statusRow(stateOf(batch), batch), [
      '7-1',
      '#7',
      'done',
      'no pull request',
    ]);
  });
});

describe('foedrum status shows a time as a person reads it (ADR 0386)', () => {
  const batch = (lane: Batch['lane']): Batch => ({
    id: '12-1',
    issue: 12,
    steps: new Map(),
    rewinds: [],
    lane,
  });

  it('foedrum status shows a routing time without milliseconds or a T', () => {
    const ordered = batch({ kind: 'ordered', routeBy: '2026-11-12T13:36:00.098Z' });
    assert.equal(describeLane(ordered, '12').detail, 'to be routed by 2026-11-12 13:36 UTC');
  });

  it('foedrum status shows a reminder time without milliseconds or a T', () => {
    const waiting = batch({
      kind: 'conditioning',
      on: { kind: 'merge', pullRequest: 'https://github.com/acme/api/pull/12' },
      remindAt: '2026-11-14T09:05:42.517Z',
    });
    assert.equal(
      describeLane(waiting, '12').detail,
      'waiting for the merge of https://github.com/acme/api/pull/12; reminder 2026-11-14 09:05 UTC',
    );
  });
});
