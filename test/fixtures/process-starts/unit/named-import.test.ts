// A unit-layer test that starts a process through a module it imports (#111).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeVersion } from '../node-version.ts';

test('reads the node version', () => {
  assert.match(nodeVersion(), /^v\d+/);
});
