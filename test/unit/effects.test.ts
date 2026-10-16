import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { applyEffect, type EffectTarget, type Ledger } from '../../src/engine/effects.ts';
import type { EffectKey } from '../../src/engine/event-store.ts';

const key: EffectKey = { batchId: '7-1', stepId: 'open-pr', attempt: 2, effect: 'pull_request' };
const text = effectKey.encode(key);

/** A ledger in memory that records what it was asked. */
const memoryLedger = (recorded: Record<string, unknown> = {}) => {
  const entries = new Map(Object.entries(recorded));
  const records: [string, unknown][] = [];
  const ledger: Ledger = {
    find: (k) => {
      const encoded = effectKey.encode(k);
      return entries.has(encoded) ? { result: entries.get(encoded) } : undefined;
    },
    record: (k, result) => {
      records.push([effectKey.encode(k), result]);
      entries.set(effectKey.encode(k), result);
    },
  };
  return { ledger, records };
};

/** A target that holds `has` and answers `apply` with `result`, recording each call. */
const fakeTarget = (has: Record<string, unknown> = {}, result: unknown = { number: 12 }) => {
  const calls: string[] = [];
  const target: EffectTarget = {
    find: async (k) => {
      calls.push(`find ${k}`);
      return k in has ? { result: has[k] } : undefined;
    },
    apply: async (k) => {
      calls.push(`apply ${k}`);
      return result;
    },
  };
  return { target, calls };
};

describe('applyEffect', () => {
  it('applies an effect neither the ledger nor the target has, then records it', async () => {
    const { ledger, records } = memoryLedger();
    const { target, calls } = fakeTarget();
    assert.deepEqual(await applyEffect(ledger, key, target), {
      result: { number: 12 },
      via: 'applied',
    });
    assert.deepEqual(calls, [`find ${text}`, `apply ${text}`]);
    assert.deepEqual(records, [[text, { number: 12 }]]);
  });

  it('answers from the ledger without asking the target', async () => {
    const { ledger, records } = memoryLedger({ [text]: { number: 9 } });
    const { target, calls } = fakeTarget();
    assert.deepEqual(await applyEffect(ledger, key, target), {
      result: { number: 9 },
      via: 'ledger',
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(records, []);
  });

  it('records what the target has when a run before applied it but never recorded it', async () => {
    const { ledger, records } = memoryLedger();
    const { target, calls } = fakeTarget({ [text]: { number: 4 } });
    assert.deepEqual(await applyEffect(ledger, key, target), {
      result: { number: 4 },
      via: 'found',
    });
    assert.deepEqual(calls, [`find ${text}`]);
    assert.deepEqual(records, [[text, { number: 4 }]]);
  });

  it('records nothing when the target fails, so the next run asks it again', async () => {
    const { ledger, records } = memoryLedger();
    const target: EffectTarget = {
      find: async () => undefined,
      apply: async () => {
        throw new Error('502 Bad Gateway');
      },
    };
    await assert.rejects(applyEffect(ledger, key, target), /502 Bad Gateway/);
    assert.deepEqual(records, []);
  });

  it('neither applies nor records when the target cannot be asked', async () => {
    const { ledger, records } = memoryLedger();
    const calls: string[] = [];
    const target: EffectTarget = {
      find: async () => {
        throw new Error('503 Service Unavailable');
      },
      apply: async (k) => {
        calls.push(`apply ${k}`);
        return { number: 12 };
      },
    };
    await assert.rejects(applyEffect(ledger, key, target), /503 Service Unavailable/);
    assert.deepEqual(calls, []);
    assert.deepEqual(records, []);
  });

  it('refuses an invalid key before it reaches the target', async () => {
    // A ledger that never looks at the key, so only applyEffect can refuse it.
    const ledger: Ledger = { find: () => undefined, record: () => {} };
    const { target, calls } = fakeTarget();
    await assert.rejects(applyEffect(ledger, { ...key, stepId: 'Open PR' }, target), /effect key/);
    assert.deepEqual(calls, []);
  });
});
