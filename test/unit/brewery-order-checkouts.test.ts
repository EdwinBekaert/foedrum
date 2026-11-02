// The pure core of a Brewery order's checkouts (ADR 0301): how each is named, made and cleaned.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkoutName } from '../../src/workspace/attempt-worktrees.ts';

describe('checkoutName (ADR 0301)', () => {
  it('names a checkout by <owner>.<name> when its alias is a Windows device name', () => {
    assert.equal(checkoutName('acme/app', 'aux'), 'acme.app');
    assert.equal(checkoutName('acme/app', 'app'), 'app');
  });
});
