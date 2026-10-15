import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AttemptFacts,
  type AttemptLimits,
  settleAttempt,
} from '../../src/engine/brewer-runner.ts';
import { OutDocFrontmatter, outDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { z } from '../../src/schemas/zod.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';

const limits: AttemptLimits = {
  outDoc: { file: 'plan.md', schema: OutDocFrontmatter },
  maxTurns: 100,
  maxDenials: 5,
};
const done = outDoc({ status: 'done', summary: 'Planned' });
const facts = (more: Partial<AttemptFacts> = {}): AttemptFacts => ({
  exit: { kind: 'exited', code: 0 },
  outDoc: done,
  denials: 0,
  turns: 10,
  ...more,
});
const succeeded = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Planned', assumptions: [] },
};

describe('settleAttempt', () => {
  it('succeeds at its limits, not past them', () => {
    assert.deepStrictEqual(settleAttempt(facts({ turns: 100, denials: 4 }), limits), succeeded);
  });

  it('counts a crash as a failure even after a valid out doc', () => {
    assert.deepStrictEqual(settleAttempt(facts({ exit: { kind: 'exited', code: 3 } }), limits), {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer process exited with code 3',
    });
  });

  it('cancels an attempt the engine stopped within its limits', () => {
    assert.deepStrictEqual(settleAttempt(facts({ exit: { kind: 'stopped' } }), limits), {
      kind: 'cancelled',
    });
  });

  it('puts the denials before the budget: the environment is what to fix', () => {
    const ending = settleAttempt(
      facts({ exit: { kind: 'stopped' }, denials: 9, turns: 101 }),
      limits,
    );
    assert.deepStrictEqual(ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: '9 permission denials, maxDenials is 5',
    });
  });

  it('applies no turn or denial limit the brewer does not set', () => {
    const unlimited = { outDoc: limits.outDoc };
    assert.deepStrictEqual(settleAttempt(facts({ turns: 900, denials: 90 }), unlimited), succeeded);
  });

  it('keeps a garbage line short in the reason', () => {
    const ending = settleAttempt(facts({ garbage: 'x'.repeat(10_000) }), limits);
    assert.equal(ending.kind, 'failed');
    assert.ok(ending.kind === 'failed' && ending.reason.length < 300, 'short reason');
  });

  it('quotes the first 120 characters of a garbage line as JSON', () => {
    const line = `\u001b[31m${'x'.repeat(200)}`;
    assert.deepStrictEqual(settleAttempt(facts({ garbage: line }), limits), {
      kind: 'failed',
      retryable: true,
      reason: `the event stream is not stream-json: "\\u001b[31m${'x'.repeat(115)}"`,
    });
  });

  it('routes a blocked out doc by its blocker kind', () => {
    const blocked = outDoc({
      status: 'blocked',
      summary: 'A test is wrong',
      blockerKind: 'findings',
    });
    assert.deepStrictEqual(settleAttempt(facts({ outDoc: blocked }), limits), {
      kind: 'blocked',
      blockerKind: 'findings',
      summary: 'A test is wrong',
    });
  });

  it("reads the out doc with the brewer's own schema", () => {
    const schema = outDocFrontmatter({ verdict: z.enum(['approve', 'changes']) });
    const review = outDoc({ status: 'done', summary: 'Looks right', verdict: 'approve' });
    const own = { ...limits, outDoc: { file: 'review.md', schema } };
    assert.deepStrictEqual(settleAttempt(facts({ outDoc: review }), own), {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Looks right', assumptions: [], verdict: 'approve' },
    });
    assert.equal(settleAttempt(facts({ outDoc: review }), limits).kind, 'failed');
  });
});
