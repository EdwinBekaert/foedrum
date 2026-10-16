import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EffectKey, EffectKeyText, Lease } from '../../src/schemas/store.ts';

const key = { batchId: 'b1', stepId: 'open-pr', attempt: 1, effect: 'pull_request' };

const rejects = (
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
): void => {
  assert.equal(schema.safeParse(value).success, false);
};

describe('EffectKey', () => {
  it('accepts a key of a batch, step, attempt and effect', () => {
    assert.deepEqual(EffectKey.parse(key), key);
  });

  const invalid: [string, unknown][] = [
    ['an empty batch id', { ...key, batchId: '' }],
    ['an empty step id', { ...key, stepId: '' }],
    ['an empty effect', { ...key, effect: '' }],
    ['attempt 0', { ...key, attempt: 0 }],
    ['a negative attempt', { ...key, attempt: -1 }],
    ['a fractional attempt', { ...key, attempt: 1.5 }],
    ['an attempt beyond the safe integers', { ...key, attempt: 2 ** 53 }],
    ['an attempt as a string', { ...key, attempt: '1' }],
    ['a missing effect', { batchId: 'b1', stepId: 'open-pr', attempt: 1 }],
    ['an unknown field', { ...key, extra: true }],
    ['a tuple', ['b1', 'open-pr', 1, 'pull_request']],
    // Batch and step ids are path segments on the state branch (ADR 0024).
    ['an upper-case batch id', { ...key, batchId: 'B1' }],
    ['a step id with a slash', { ...key, stepId: 'open/pr' }],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => rejects(EffectKey, value));
  }

  // Effects of a batch rather than one of its attempts: a claim's marks and release (ADR 0043).
  const batchKey = { batchId: 'b1', effect: 'claim.label' };

  it('accepts a key of a batch and effect', () => {
    assert.deepEqual(EffectKey.parse(batchKey), batchKey);
  });

  const invalidBatchKeys: [string, unknown][] = [
    ['an empty batch id', { ...batchKey, batchId: '' }],
    ['an empty effect', { ...batchKey, effect: '' }],
    ['an upper-case batch id', { ...batchKey, batchId: 'B1' }],
    ['a step without an attempt', { ...batchKey, stepId: 'plan' }],
    ['an attempt without a step', { ...batchKey, attempt: 1 }],
    ['an unknown field', { ...batchKey, extra: true }],
  ];
  for (const [name, value] of invalidBatchKeys) {
    it(`rejects a batch key with ${name}`, () => rejects(EffectKey, value));
  }
});

describe('EffectKeyText', () => {
  const canonical: [string, string][] = [
    ['a plain key', '["b1","open-pr",1,"pull_request"]'],
    ['ids with separators', JSON.stringify(['a.b-c', 'x_y.z', 2, 'pr'])],
    ['an effect with separators and quotes', JSON.stringify(['b1', 'plan', 2, '"],["#:b/c'])],
    ['an effect with control characters', JSON.stringify(['b1', 'plan', 3, 'x\n\t\u0001'])],
    [
      'an effect outside ASCII and a lone surrogate',
      JSON.stringify(['b1', 'plan', 9, 'bière\ud800🍺']),
    ],
    ['the largest safe attempt', JSON.stringify(['b1', 'open-pr', 2 ** 53 - 1, 'pr'])],
  ];
  for (const [name, text] of canonical) {
    it(`accepts the canonical text of ${name}`, () => {
      assert.equal(EffectKeyText.parse(text), text);
    });
  }

  const invalid: [string, unknown][] = [
    ['a number', 42],
    ['text that is not JSON', 'b1/open-pr#1/pull_request'],
    ['an empty text', ''],
    ['an object', JSON.stringify(key)],
    ['three parts', '["b1","open-pr",1]'],
    ['five parts', '["b1","open-pr",1,"pull_request","x"]'],
    ['an attempt as a string', '["b1","open-pr","1","pull_request"]'],
    ['an empty part', '["","open-pr",1,"pull_request"]'],
    ['an empty effect', '["b1","open-pr",1,""]'],
    ['a null part', '["b1",null,1,"pull_request"]'],
    ['attempt 0', '["b1","open-pr",0,"pull_request"]'],
    ['a fractional attempt', '["b1","open-pr",1.5,"pull_request"]'],
    ['an attempt beyond the safe integers', '["b1","open-pr",9007199254740992,"pull_request"]'],
    ['a non-canonical spelling (spaces)', '["b1", "open-pr", 1, "pull_request"]'],
    ['a non-canonical spelling (exponent)', '["b1","open-pr",1e0,"pull_request"]'],
    ['a non-canonical spelling (trailing zero)', '["b1","open-pr",1.0,"pull_request"]'],
    ['a non-canonical spelling (escape)', '["\\u00621","open-pr",1,"pull_request"]'],
    ['a non-canonical spelling (escaped slash)', '["b\\/1","open-pr",1,"pull_request"]'],
    ['a non-canonical spelling (control escape)', '["b\\u000a1","open-pr",1,"pull_request"]'],
    ['a trailing newline', '["b1","open-pr",1,"pull_request"]\n'],
    ['an upper-case batch id', '["B1","open-pr",1,"pull_request"]'],
    ['a step id with a slash', '["b1","open/pr",1,"pull_request"]'],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => rejects(EffectKeyText, value));
  }

  it('accepts the canonical text of a batch key', () => {
    assert.equal(EffectKeyText.safeParse('["b1","claim.label"]').success, true);
  });

  const invalidBatchTexts: [string, unknown][] = [
    ['one part', '["b1"]'],
    ['an empty effect', '["b1",""]'],
    ['an upper-case batch id', '["B1","claim.label"]'],
    ['a number for the effect', '["b1",1]'],
    ['a non-canonical spelling (spaces)', '["b1", "claim.label"]'],
  ];
  for (const [name, value] of invalidBatchTexts) {
    it(`rejects a batch key text with ${name}`, () => rejects(EffectKeyText, value));
  }
});

describe('Lease', () => {
  const lease = {
    attemptKey: '["b1","plan",1]',
    owner: 'worker-1',
    expiresAt: new Date(Date.UTC(2026, 9, 15)),
  };

  it('accepts who holds an attempt until when', () => {
    assert.deepEqual(Lease.parse(lease), lease);
  });

  const canonical: [string, string][] = [
    ['ids with separators', JSON.stringify(['a.b-c', 'x_y.z', 2])],
    ['the largest safe attempt', JSON.stringify(['b1', 'plan', 2 ** 53 - 1])],
  ];
  for (const [name, attemptKey] of canonical) {
    it(`accepts the canonical attempt key of ${name}`, () => {
      assert.equal(Lease.parse({ ...lease, attemptKey }).attemptKey, attemptKey);
    });
  }

  const invalid: [string, unknown][] = [
    ['an empty attempt key', { ...lease, attemptKey: '' }],
    ['an empty owner', { ...lease, owner: '' }],
    ['an expiry as text', { ...lease, expiresAt: '2026-10-15T00:00:00.000Z' }],
    ['an expiry as a number', { ...lease, expiresAt: Date.UTC(2026, 9, 15) }],
    ['an invalid date', { ...lease, expiresAt: new Date(Number.NaN) }],
    ['a missing owner', { attemptKey: '["b1","plan",1]', expiresAt: lease.expiresAt }],
    ['an unknown field', { ...lease, extra: true }],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => rejects(Lease, value));
  }

  const otherKeys: [string, string][] = [
    ['a key that is not JSON', 'b1/plan#1'],
    ['an object', JSON.stringify({ batchId: 'b1', stepId: 'plan', attempt: 1 })],
    ['two parts', '["b1","plan"]'],
    ['four parts', '["b1","plan",1,"x"]'],
    ['an attempt as a string', '["b1","plan","1"]'],
    ['an empty part', '["","plan",1]'],
    ['a null part', '["b1",null,1]'],
    ['attempt 0', '["b1","plan",0]'],
    ['a fractional attempt', '["b1","plan",1.5]'],
    ['an attempt beyond the safe integers', '["b1","plan",9007199254740992]'],
    ['a non-canonical spelling (spaces)', '["b1", "plan", 1]'],
    ['a non-canonical spelling (exponent)', '["b1","plan",1e0]'],
    ['a non-canonical spelling (trailing zero)', '["b1","plan",1.0]'],
    ['a non-canonical spelling (escape)', '["\\u00621","plan",1]'],
    ['a non-canonical spelling (escaped slash)', '["b\\/1","plan",1]'],
    ['a trailing newline', '["b1","plan",1]\n'],
    ['an upper-case batch id', '["B1","plan",1]'],
    ['a step id with a slash', '["b1","pl/an",1]'],
  ];
  for (const [name, attemptKey] of otherKeys) {
    it(`rejects an attempt key of ${name}`, () => {
      const result = Lease.safeParse({ ...lease, attemptKey });
      assert.equal(result.success, false);
      assert.match(result.error?.message ?? '', /Must be a canonical attempt key/);
    });
  }
});
