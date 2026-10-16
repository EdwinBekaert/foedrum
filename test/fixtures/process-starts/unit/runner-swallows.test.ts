// A unit-layer test that starts a process through the real process runner, which reports a
// process that could not start as a result instead of throwing (#111).
import { test } from 'node:test';
import { spawnProcess } from '../../../../src/platform/processes.ts';

test('runs node', async () => {
  await spawnProcess(process.execPath, ['--version'], process.cwd());
});
