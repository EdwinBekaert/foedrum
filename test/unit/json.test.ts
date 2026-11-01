import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJson } from '../../src/formats/json.ts';

describe('parseJson', () => {
  it('reads malformed text as undefined instead of throwing', () => {
    assert.equal(parseJson('{"id": 1,'), undefined);
  });
});
