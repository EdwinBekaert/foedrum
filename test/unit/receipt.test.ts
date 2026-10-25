// An attempt's receipt as a person reads it (#447, ADR 0172): one line per attempt, a batch's
// total, in the status comment and in `foedrum status`. Plain folded batches, no process.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatStatus } from '../../src/cli/status.ts';
import { type Attempt, type Batch, emptyState, type Step } from '../../src/engine/fold.ts';
import { receiptParts, receiptsOf, totalParts } from '../../src/engine/receipt.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import { Receipt, type Usage } from '../../src/schemas/events.ts';

const at = '2026-10-24T09:00:00.000Z';
const tokens = (total: number): Usage => ({
  inputTokens: 1000,
  outputTokens: 39_000,
  cacheReadTokens: total - 140_000,
  cacheWriteTokens: 100_000,
});
/** A receipt as the event store reads it, with the cost an event from before ADR 0181 holds. */
const receipt = (more: Partial<Receipt> = {}): Receipt =>
  Receipt.parse({
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
  it('shows the duration, turns, tokens and the denials with what was refused, never a cost', () => {
    const denied = [{ tool: 'Bash', count: 2, refused: ['git push'] }];
    assert.deepEqual(receiptParts(receipt({ denied }), tokens(1_340_000)), [
      '2m 38s',
      '31 turns',
      '1.34M tokens',
      '2 denied (Bash: git push)',
    ]);
  });

  it('leaves out what an incomplete receipt does not have, and says it is incomplete', () => {
    const seen = receipt({ complete: false, durationMs: 45_400, turns: 1 });
    delete seen.apiDurationMs;
    assert.deepEqual(receiptParts(seen, undefined), ['45s', '1 turn', 'incomplete']);
  });

  it('writes small and large amounts readably', () => {
    const small = receiptParts(receipt({ durationMs: 3_725_000 }), {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 1670,
      cacheWriteTokens: 2452,
    });
    assert.deepEqual(small, ['1h 2m', '31 turns', '4.13k tokens']);
    const tiny = receiptParts(receipt({ durationMs: 0 }), {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(tiny, ['0s', '31 turns', '1 token']);
  });

  // Review of #459: rounded to three digits, 999,600 is a million.
  it('writes a count that rounds to a thousand thousands in millions', () => {
    const near = receiptParts(receipt(), tokens(999_600));
    assert.equal(near[2], '1M tokens');
    assert.equal(receiptParts(receipt(), tokens(999_400))[2], '999k tokens');
  });

  // Review of #459 (Brett): the edge of a minute.
  it('writes a whole minute in minutes', () => {
    assert.equal(receiptParts(receipt({ durationMs: 59_400 }), undefined)[0], '59s');
    assert.equal(receiptParts(receipt({ durationMs: 60_000 }), undefined)[0], '1m 0s');
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

  // Review of #459: a route back runs a step again after another one.
  it('follows the path where it goes back to a step, not the order of the steps', () => {
    const back = batch({
      steps: new Map([
        step('implement', finished(1, { receipt: receipt() }), finished(2, { receipt: receipt() })),
        step('review', finished(1, { receipt: receipt() })),
      ]),
      path: [
        { stepId: 'implement', attempt: 1 },
        { stepId: 'review', attempt: 1 },
        { stepId: 'implement', attempt: 2 },
      ],
    });
    assert.deepEqual(
      receiptsOf(back).map(({ stepId, attempt }) => `${stepId} #${attempt}`),
      ['implement #1', 'review #1', 'implement #2'],
    );
  });

  // A resumed run reports its session's cost so far (ADR 0042), which no line shows (ADR 0181);
  // its tokens are its own run's usage (ADR 0172).
  it("shows a resumed attempt's own tokens, and no cost for its session", () => {
    const sessionOf = { session: { id: 's1', worktree: '/work/7-1' } };
    const ran = batch({
      steps: new Map([
        step(
          'implement',
          finished(1, { ...sessionOf, receipt: receipt(), usage: tokens(200_000) }),
          finished(2, {
            ...sessionOf,
            receipt: receipt({ resumed: true }),
            usage: tokens(1_340_000),
          }),
        ),
      ]),
      path: [
        { stepId: 'implement', attempt: 1 },
        { stepId: 'implement', attempt: 2 },
      ],
    });
    assert.match(
      renderStatus(ran, ['implement']),
      /^- `implement #2` · 2m 38s · 31 turns · 1\.34M tokens$/m,
    );
    assert.deepEqual(totalParts(ran), ['2 attempts', '5m 16s', '62 turns', '1.54M tokens']);
  });

  // ADR 0175: the receipt says why the attempt went on in the session before it.
  it('ends the receipt line of an attempt that resumed after the turn budget with it', () => {
    const id = 's1';
    const ran = batch({
      steps: new Map([
        step(
          'gauge',
          finished(1, {
            session: { id, worktree: '/work/7-1' },
            receipt: receipt(),
            outcome: { kind: 'failed', retryable: true, reason: 'budget', overran: 'turns' },
          }),
          finished(2, { session: { id, resumes: id, worktree: '/work/7-1' }, receipt: receipt() }),
        ),
      ]),
      path: [
        { stepId: 'gauge', attempt: 1 },
        { stepId: 'gauge', attempt: 2 },
      ],
    });
    const text = renderStatus(ran, ['gauge']);
    assert.match(text, /^- `gauge #1` · 2m 38s · 31 turns$/m);
    assert.match(text, /^- `gauge #2` · 2m 38s · 31 turns · resumed after the turn budget$/m);
  });

  it('sums them', () => {
    assert.deepEqual(totalParts(ran), [
      '2 attempts',
      '2m 58s',
      '36 turns',
      '1.54M tokens',
      '2 denied',
    ]);
  });

  // Review of #459: a part with nothing to show is left out of the total too (ADR 0172).
  it('leaves out of the total what no receipt measured', () => {
    const seen = receipt({ complete: false, turns: 2 });
    delete seen.durationMs;
    const unmeasured = batch({
      steps: new Map([step('plan', finished(1, { receipt: seen }))]),
      path: [{ stepId: 'plan', attempt: 1 }],
    });
    assert.deepEqual(totalParts(unmeasured), ['1 attempt', '2 turns']);
  });

  it('has no total without a receipt', () => {
    const unreceipted = batch({
      steps: new Map([step('plan', finished(1))]),
      path: [{ stepId: 'plan', attempt: 1 }],
    });
    assert.deepEqual(totalParts(unreceipted), []);
  });

  it('shows one receipt line per attempt in the status comment, under Receipts', () => {
    const text = renderStatus(ran, ['plan', 'implement']);
    const lines = text.split('\n');
    const from = lines.indexOf('**Receipts**');
    assert.ok(from > 0, text);
    assert.deepEqual(lines.slice(from + 1, from + 3), [
      '- `plan #1` · 20s · 5 turns · 200k tokens',
      '- `implement #1` · 2m 38s · 31 turns · 1.34M tokens · 2 denied (Bash: git push)',
    ]);
  });

  it('shows no Receipts section without a receipt', () => {
    const unreceipted = batch({
      steps: new Map([step('plan', finished(1))]),
      path: [{ stepId: 'plan', attempt: 1 }],
    });
    const text = renderStatus(unreceipted, ['plan']);
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
      /brewing\s+implement #3 started; 2 attempts \/ 2m 58s \/ 36 turns \/ 1\.54M tokens \/ 2 denied$/,
    );
    assert.match(row ?? '', /^[\x20-\x7e]*$/);
  });

  it('shows no dollar amount in the status comment or foedrum status (ADR 0181)', () => {
    const state = { ...emptyState, batches: new Map([[ran.id, ran]]) };
    assert.doesNotMatch(renderStatus(ran, ['plan', 'implement']), /\$|est\./);
    assert.doesNotMatch(formatStatus(state), /\$|est\./);
  });
});
