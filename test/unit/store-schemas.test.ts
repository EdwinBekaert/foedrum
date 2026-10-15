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
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => rejects(EffectKey, value));
  }
});

describe('EffectKeyText', () => {
  const canonical: [string, string][] = [
    ['a plain key', '["b1","open-pr",1,"pull_request"]'],
    ['parts with separators and quotes', JSON.stringify(['a:b/c', '"],["#', 2, 'x\\y,z'])],
    ['parts with control characters', JSON.stringify(['b\n1', 'step\t', 3, '\u0001'])],
    ['parts outside ASCII and a lone surrogate', JSON.stringify(['bière', '\ud800', 9, '🍺'])],
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
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => rejects(EffectKeyText, value));
  }
});

describe('Lease', () => {
  const lease = {
    attemptKey: 'b1/plan/1',
    owner: 'worker-1',
    expiresAt: new Date(Date.UTC(2026, 9, 15)),
  };

  it('accepts who holds an attempt until when', () => {
    assert.deepEqual(Lease.parse(lease), lease);
  });

  const invalid: [string, unknown][] = [
    ['an empty attempt key', { ...lease, attemptKey: '' }],
    ['an empty owner', { ...lease, owner: '' }],
    ['an expiry as text', { ...lease, expiresAt: '2026-10-15T00:00:00.000Z' }],
    ['an expiry as a number', { ...lease, expiresAt: Date.UTC(2026, 9, 15) }],
    ['an invalid date', { ...lease, expiresAt: new Date(Number.NaN) }],
    ['a missing owner', { attemptKey: 'b1/plan/1', expiresAt: lease.expiresAt }],
    ['an unknown field', { ...lease, extra: true }],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => rejects(Lease, value));
  }
});
