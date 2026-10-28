// How `foedrum status` and `foedrum stuck` describe a batch's lane: what it does or waits for.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeLane } from '../../src/cli/status.ts';
import type { Batch } from '../../src/engine/fold.ts';

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
    assert.deepStrictEqual(describeLane(batch), {
      lane: 'stuck',
      detail: `https://github.com/acme/api/pull/12 failed its checks on ${'c'.repeat(40)} at open-pull-request after 2 rounds; reminder 2026-10-17T12:00:00.000Z`,
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
    assert.deepStrictEqual(describeLane(batch), {
      lane: 'stuck',
      detail: `https://github.com/acme/api/pull/12 fails its checks on the merged tree with main at ${'e'.repeat(40)}: the check "test" (npm test), at open-pull-request after 1 round; reminder 2026-10-17T12:00:00.000Z`,
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
    assert.deepStrictEqual(describeLane(batch), {
      lane: 'stuck',
      detail: `https://github.com/acme/api/pull/12 conflicts with main at ${'e'.repeat(40)} in src/a.ts, logo.png, at open-pull-request after 2 rounds; reminder 2026-10-17T12:00:00.000Z`,
    });
  });
});
