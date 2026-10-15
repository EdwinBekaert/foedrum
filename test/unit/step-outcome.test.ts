import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Question, StepOutcome } from '../../src/schemas/step-outcome.ts';

const question = {
  q: 'Which table holds the audit log?',
  options: ['audit_log', 'events'],
  recommended: 'audit_log',
  whyBlocking: 'The migration writes to it',
};

describe('Question', () => {
  it('accepts a question with options, a recommendation and why it blocks', () => {
    assert.deepEqual(Question.parse(question), question);
  });

  const invalid: [string, unknown][] = [
    ['an empty question', { ...question, q: '' }],
    ['fewer than two options', { ...question, options: ['audit_log'], recommended: 'audit_log' }],
    ['a recommendation that is not an option', { ...question, recommended: 'logs' }],
    ['no reason why it blocks', { ...question, whyBlocking: undefined }],
    ['an unknown field', { ...question, extra: true }],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(Question.safeParse(value).success, false);
    });
  }
});

describe('StepOutcome', () => {
  // Typed as a record so that adding or removing a kind fails the typecheck until this list follows.
  const valid: Record<StepOutcome['kind'], StepOutcome> = {
    succeeded: { kind: 'succeeded', output: { pullRequest: 12 } },
    failed: { kind: 'failed', retryable: true, reason: 'Out doc missing' },
    needs_input: { kind: 'needs_input', questions: [question] },
    cancelled: { kind: 'cancelled' },
  };
  for (const [kind, outcome] of Object.entries(valid)) {
    it(`accepts ${kind}`, () => {
      assert.deepEqual(StepOutcome.parse(outcome), outcome);
    });
  }

  const invalid: [string, unknown][] = [
    ['an unknown kind', { kind: 'skipped' }],
    ['no kind', { output: 1 }],
    ['succeeded without output', { kind: 'succeeded' }],
    ['succeeded with an output that is not JSON', { kind: 'succeeded', output: () => 1 }],
    ['failed without retryable', { kind: 'failed', reason: 'x' }],
    ['failed without a reason', { kind: 'failed', retryable: false, reason: '' }],
    ['needs_input without questions', { kind: 'needs_input', questions: [] }],
    ['needs_input with an invalid question', { kind: 'needs_input', questions: [{ q: 'Why?' }] }],
    ['cancelled with extra fields', { kind: 'cancelled', reason: 'x' }],
    ['fields of another kind', { kind: 'succeeded', output: 1, retryable: true }],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(StepOutcome.safeParse(value).success, false);
    });
  }
});
