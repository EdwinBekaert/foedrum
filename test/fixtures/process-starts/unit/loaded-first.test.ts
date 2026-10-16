// A unit-layer test that starts a process through each kind of ES import of node:child_process,
// run where the built-in's ES module was loaded before npm test's preload (#111).
import * as namespace from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const args = ['--version'];

test('starts node through a named import', () => {
  spawnSync(process.execPath, args);
});

test('starts node through a namespace import', () => {
  namespace.spawnSync(process.execPath, args);
});

test('starts node through a dynamic import', async () => {
  const dynamic = await import('node:child_process');
  dynamic.spawnSync(process.execPath, args);
});
