// The driver lock between real processes (ADR 0037): a second process of a driver is refused while
// the first holds its lock, and a process that dies holding it, without releasing it, leaves a lock
// that the next process takes over without any cleanup.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { lockDriver } from '../../src/engine/driver-lock.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const module = pathToFileURL(
  join(import.meta.dirname, '..', '..', 'src', 'engine', 'driver-lock.ts'),
);
const cellar = { brewery: 'acme/brewery', owner: 'cellar' };

// A Foedrum process: takes the cellar's lock on the work root in argv, then runs `then`.
const child = (workRoot: string, then: string) =>
  execProcess(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { lockDriver } from ${JSON.stringify(module.href)};
       try { lockDriver(process.argv[1], ${JSON.stringify(cellar)}); }
       catch (error) { console.log(error.name); process.exit(3); }
       console.log('locked');
       ${then}`,
      workRoot,
    ],
    { cwd: import.meta.dirname, timeoutMs: 30_000 },
  );

describe('the driver lock between processes', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('driver-lock');
  });
  afterEach(() => dir.remove());

  it('refuses another process of the driver while this one holds it, and lets it in once released', async () => {
    const workRoot = join(dir.path, 'work');
    const lock = lockDriver(workRoot, cellar);

    const refused = await child(workRoot, '');
    lock.release();
    const taken = await child(workRoot, '');

    assert.deepEqual([refused.exitCode, refused.stdout.trim()], [3, 'DriverRunningError']);
    assert.deepEqual([taken.exitCode, taken.stdout.trim()], [0, 'locked']);
  });

  it('is taken over once a process that held it dies without releasing it', async () => {
    const workRoot = join(dir.path, 'work');

    const died = await child(workRoot, "process.kill(process.pid, 'SIGKILL');");
    const lock = lockDriver(workRoot, cellar);

    assert.equal(died.stdout.trim(), 'locked');
    assert.notEqual(died.exitCode, 0);
    assert.equal(lock.held, true);
    const holder = JSON.parse(
      readFileSync(join(workRoot, 'drivers', 'cellar.holder.json'), 'utf8'),
    );
    assert.equal(holder.pid, process.pid);
    lock.release();
  });
});
