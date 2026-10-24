// An attempt's receipt as a person reads it (#447, ADR 0172): one line per attempt, a batch's
// total, in the status comment and in `foedrum status`. Plain folded batches, no process.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatStatus } from '../../src/cli/status.ts';
import { type Attempt, type Batch, emptyState, type Step } from '../../src/engine/fold.ts';
import { receiptParts, receiptsOf, totalParts } from '../../src/engine/receipt.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import type { Receipt, Usage } from '../../src/schemas/events.ts';

const at = '2026-10-24T09:00:00.000Z';
const tokens = (total: number): Usage => ({
  inputTokens: 1000,
  outputTokens: 39_000,
  cacheReadTokens: total - 140_000,
  cacheWriteTokens: 100_000,
});
const receipt = (more: Partial<Receipt> = {}): Receipt => ({
  complete: true,
  durationMs: 158_000,
  apiDurationMs: 120_000,
  turns: 31,
  costUsd: 0.8215,
  edits: 4,
  toolErrors: 0,
  denied: [],
  ...more,
});
const finished = (attempt: number, more: Partial<Extract<Attempt, { phase: 'finished' }>> = {}) =>
  ({
    phase: 'finished',
    attempt,
    deadlineAt: at,
    outcome: { kind: 'failed', retryable: true, reason: 'crash' },
    ...more,
  }) satisfies Attempt;
const step = (id: string, ...attempts: Attempt[]): [string, Step] => [
  id,
  { id, attempts: new Map(attempts.map((each) => [each.attempt, each])), inputs: [] },
];
const batch = (fields: Partial<Batch> = {}): Batch => ({
  id: '7-1',
  issue: 7,
  recipe: { name: 'nip', reason: 'label', source: 'label' },
  lane: { kind: 'brewing' },
  steps: new Map(),
  rewinds: [],
  ...fields,
});

describe('receiptParts', () => {
  it('shows the duration, turns, tokens, cost as an estimate, and the denials with what was refused', () => {
    const denied = [{ tool: 'Bash', count: 2, refused: ['git push'] }];
    assert.deepEqual(receiptParts(receipt({ denied }), tokens(1_340_000)), [
      '2m 38s',
      '31 turns',
      '1.34M tokens',
      '$0.82 est.',
      '2 denied (Bash: git push)',
    ]);
  });

  it('leaves out what an incomplete receipt does not have, and says it is incomplete', () => {
    const seen = receipt({ complete: false, durationMs: 45_400, turns: 1 });
    delete seen.costUsd;
    delete seen.apiDurationMs;
    assert.deepEqual(receiptParts(seen, undefined), ['45s', '1 turn', 'incomplete']);
  });

  it('writes small and large amounts readably', () => {
    const small = receiptParts(receipt({ durationMs: 3_725_000, costUsd: 0.0005 }), {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 1670,
      cacheWriteTokens: 2452,
    });
    assert.deepEqual(small.slice(0, 4), ['1h 2m', '31 turns', '4.13k tokens', '<$0.01 est.']);
    const tiny = receiptParts(receipt({ durationMs: 0, costUsd: 0 }), {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(tiny.slice(0, 4), ['0s', '31 turns', '1 token', '$0.00 est.']);
  });

  it('names each denied family, and shows the refused prefixes through told', () => {
    const denied = [
      { tool: 'Write', count: 1, refused: [] },
      { tool: 'Bash', count: 2, refused: ['git push', 'npm publish'] },
    ];
    const parts = receiptParts(receipt({ denied }), undefined, (text) => `<${text}>`);
    assert.equal(parts.at(-1), '3 denied (<Write>; <Bash>: <git push>, <npm publish>)');
  });
});

describe("a batch's receipts", () => {
  const ran = batch({
    steps: new Map([
      step(
        'plan',
        finished(1, { receipt: receipt({ durationMs: 20_000, turns: 5 }), usage: tokens(200_000) }),
      ),
      step(
        'implement',
        finished(1, {
          receipt: receipt({ denied: [{ tool: 'Bash', count: 2, refused: ['git push'] }] }),
          usage: tokens(1_340_000),
        }),
        // A finished attempt from before receipts, and a running one: neither has a receipt.
        finished(2),
        { phase: 'started', attempt: 3, deadlineAt: at },
      ),
    ]),
    path: [
      { stepId: 'plan', attempt: 1 },
      { stepId: 'implement', attempt: 1 },
      { stepId: 'implement', attempt: 2 },
      { stepId: 'implement', attempt: 3 },
    ],
  });

  it('lists the attempts with a receipt in the order they ran', () => {
    assert.deepEqual(
      receiptsOf(ran).map(({ stepId, attempt }) => `${stepId} #${attempt}`),
      ['plan #1', 'implement #1'],
    );
  });

  it('sums them', () => {
    assert.deepEqual(totalParts(ran), [
      '2 attempts',
      '2m 58s',
      '36 turns',
      '1.54M tokens',
      '$1.64 est.',
      '2 denied',
    ]);
  });

  it('has no total without a receipt', () => {
    assert.deepEqual(totalParts(batch({ steps: new Map([step('plan', finished(1))]) })), []);
  });

  it('shows one receipt line per attempt in the status comment, under Receipts', () => {
    const text = renderStatus(ran, ['plan', 'implement']);
    const lines = text.split('\n');
    const from = lines.indexOf('**Receipts**');
    assert.ok(from > 0, text);
    assert.deepEqual(lines.slice(from + 1, from + 3), [
      '- `plan #1` · 20s · 5 turns · 200k tokens · $0.82 est.',
      '- `implement #1` · 2m 38s · 31 turns · 1.34M tokens · $0.82 est. · 2 denied (Bash: git push)',
    ]);
  });

  it('shows no Receipts section without a receipt', () => {
    const text = renderStatus(batch({ steps: new Map([step('plan', finished(1))]) }), ['plan']);
    assert.doesNotMatch(text, /Receipts/);
  });

  it('shows at most 30 receipt lines in the status comment, and counts the rest', () => {
    const many = Array.from({ length: 32 }, (_, index) =>
      finished(index + 1, { receipt: receipt() }),
    );
    const text = renderStatus(
      batch({
        steps: new Map([step('brew', ...many)]),
        path: many.map(({ attempt }) => ({ stepId: 'brew', attempt })),
      }),
      ['brew'],
    );
    const shown = text.split('\n').filter((line) => /^- `brew #\d+` · /.test(line));
    assert.equal(shown.length, 30);
    assert.match(text, /^- and 2 more$/m);
  });

  // A refused prefix is model output: it is escaped as every text a brewer wrote (ADR 0088).
  it('escapes a refused prefix in the status comment', () => {
    const denied = [{ tool: 'Bash', count: 1, refused: ['rm -_x_'] }];
    const text = renderStatus(
      batch({
        steps: new Map([step('brew', finished(1, { receipt: receipt({ denied }) }))]),
        path: [{ stepId: 'brew', attempt: 1 }],
      }),
      ['brew'],
    );
    assert.match(text, /1 denied \(Bash: rm -\\_x\\_\)/);
  });

  // Review of #459: a pipe on Windows decodes the terminal's output with its code page, so the
  // terminal's line is ASCII; the status comment keeps its middle dot.
  it("adds each batch's total to its row in foedrum status, in ASCII", () => {
    const state = { ...emptyState, batches: new Map([[ran.id, ran]]) };
    const row = formatStatus(state)
      .split('\n')
      .find((line) => line.trimStart().startsWith('7-1'));
    assert.match(
      row ?? '',
      /brewing\s+implement #3 started; 2 attempts \/ 2m 58s \/ 36 turns \/ 1\.54M tokens \/ \$1\.64 est\. \/ 2 denied$/,
    );
    assert.match(row ?? '', /^[\x20-\x7e]*$/);
  });
});
