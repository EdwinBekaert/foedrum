import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EffectKey } from '../../src/engine/event-store.ts';

const key: EffectKey = { batchId: 'b1', stepId: 'open-pr', attempt: 1, effect: 'pull_request' };

describe('effectKey', () => {
  it('encodes a key as a JSON array of its parts', () => {
    assert.equal(effectKey.encode(key), '["b1","open-pr",1,"pull_request"]');
  });

  it('decodes what it encodes, also parts that contain separators or quotes', () => {
    const awkward: EffectKey = {
      batchId: 'a.b-c',
      stepId: 'x_y.z',
      attempt: 2,
      effect: '"],["#:b/c\\y,z',
    };
    for (const k of [key, awkward]) assert.deepEqual(effectKey.decode(effectKey.encode(k)), k);
  });

  it('encodes only the four parts of a key that carries other fields', () => {
    const attempt = { batchId: 'b1', stepId: 'open-pr', attempt: 1, deadlineAt: '2026-10-15' };
    assert.equal(
      effectKey.encode({ ...attempt, effect: 'pull_request' }),
      '["b1","open-pr",1,"pull_request"]',
    );
  });

  it('encodes the key of a batch effect as a JSON array of its batch and effect', () => {
    const batchKey: EffectKey = { batchId: 'b1', effect: 'claim.label' };
    assert.equal(effectKey.encode(batchKey), '["b1","claim.label"]');
    assert.deepEqual(effectKey.decode('["b1","claim.label"]'), batchKey);
  });

  it('refuses to encode a batch key with an empty effect or an invalid batch id', () => {
    const invalid: EffectKey[] = [
      { batchId: 'b1', effect: '' },
      { batchId: 'B1', effect: 'claim.label' },
    ];
    for (const k of invalid) assert.throws(() => effectKey.encode(k), /Invalid effect key/);
  });

  it('encodes only the two parts of a batch key that carries other fields', () => {
    const batch = { batchId: 'b1', deadlineAt: '2026-10-15' };
    assert.equal(effectKey.encode({ ...batch, effect: 'claim.label' }), '["b1","claim.label"]');
  });

  it('refuses to encode a key with a step but no attempt', () => {
    const half = { batchId: 'b1', stepId: 'plan', effect: 'pr' } as unknown as EffectKey;
    assert.throws(() => effectKey.encode(half), /Invalid effect key/);
  });

  it('gives different texts to keys whose parts would join to the same text', () => {
    const pairs: [EffectKey, EffectKey][] = [
      [
        { ...key, batchId: 'a.b', stepId: 'c' },
        { ...key, batchId: 'a', stepId: 'b.c' },
      ],
      [
        { ...key, batchId: 'a-b', stepId: 'c' },
        { ...key, batchId: 'a', stepId: 'b-c' },
      ],
    ];
    for (const [one, other] of pairs) {
      assert.notEqual(effectKey.encode(one), effectKey.encode(other));
    }
  });

  const invalidKeys: [string, EffectKey][] = [
    ['an empty batch id', { ...key, batchId: '' }],
    ['an empty step id', { ...key, stepId: '' }],
    ['an empty effect', { ...key, effect: '' }],
    ['attempt 0', { ...key, attempt: 0 }],
    ['a fractional attempt', { ...key, attempt: 1.5 }],
    // Batch and step ids are path segments on the state branch (ADR 0024).
    ['an upper-case batch id', { ...key, batchId: 'B1' }],
    ['a step id with a slash', { ...key, stepId: 'open/pr' }],
  ];
  for (const [what, invalid] of invalidKeys) {
    it(`refuses to encode a key with ${what}`, () => {
      assert.throws(() => effectKey.encode(invalid), /Invalid effect key/);
    });
  }

  const invalidTexts: [string, string][] = [
    ['text that is not JSON', 'b1/open-pr#1/pull_request'],
    ['an object', '{"batchId":"b1","stepId":"open-pr","attempt":1,"effect":"pull_request"}'],
    ['three parts', '["b1","open-pr",1]'],
    ['five parts', '["b1","open-pr",1,"pull_request","x"]'],
    ['an attempt as a string', '["b1","open-pr","1","pull_request"]'],
    ['an empty part', '["","open-pr",1,"pull_request"]'],
    ['attempt 0', '["b1","open-pr",0,"pull_request"]'],
    ['a non-canonical spelling (spaces)', '["b1", "open-pr", 1, "pull_request"]'],
    ['a non-canonical spelling (exponent)', '["b1","open-pr",1e0,"pull_request"]'],
    ['a non-canonical spelling (escape)', '["\\u00621","open-pr",1,"pull_request"]'],
  ];
  for (const [what, text] of invalidTexts) {
    it(`refuses to decode ${what}`, () => {
      assert.throws(() => effectKey.decode(text), /Invalid effect key/);
    });
  }
});
