import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';

const ref: AttemptRef = { batchId: 'b1', stepId: 'plan', attempt: 2 };

describe('attemptKey', () => {
  it('encodes an attempt as a JSON array of its parts', () => {
    assert.equal(attemptKey.encode(ref), '["b1","plan",2]');
  });

  it('encodes only the three parts of an attempt that carries other fields', () => {
    const scheduled = { ...ref, deadlineAt: '2026-10-15T12:00:00.000Z' };
    assert.equal(attemptKey.encode(scheduled), '["b1","plan",2]');
  });

  it('decodes what it encodes', () => {
    assert.deepEqual(attemptKey.decode(attemptKey.encode(ref)), ref);
  });

  const invalid: [string, AttemptRef][] = [
    ['a batch id that is not a path segment', { ...ref, batchId: 'B1' }],
    ['a step id that is not a path segment', { ...ref, stepId: '../plan' }],
    ['attempt 0', { ...ref, attempt: 0 }],
    ['a fractional attempt', { ...ref, attempt: 1.5 }],
  ];
  for (const [what, bad] of invalid) {
    it(`refuses to encode ${what}`, () => {
      assert.throws(() => attemptKey.encode(bad), /Invalid attempt key/);
    });
  }

  for (const text of [
    'b1/plan#1',
    '["b1","plan"]',
    '["b1","plan",1,"x"]',
    '[ "b1","plan",1]',
    '["b1","plan",0]',
    '["B1","plan",1]',
    '{"batchId":"b1"}',
    'not json',
  ]) {
    it(`decodes ${text} to nothing`, () => {
      assert.equal(attemptKey.decode(text), undefined);
    });
  }
});
