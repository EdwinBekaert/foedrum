import assert from 'node:assert/strict';
import { chmodSync, existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { removeStaleIndexLock } from '../../src/platform/index-lock.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('removeStaleIndexLock', () => {
  let dir: TempDir;
  let lock: string;
  // The lock was last written at this time; the tests set the clock relative to it.
  let written: number;
  beforeEach(() => {
    dir = makeTempDir('index-lock');
    lock = join(dir.path, 'index.lock');
    writeFileSync(lock, '');
    written = statSync(lock).mtimeMs;
  });
  afterEach(() => dir.remove());

  it('removes a lock older than the limit', async () => {
    const result = await removeStaleIndexLock(dir.path, {
      maxAgeMs: 60_000,
      now: () => written + 60_000,
    });
    assert.equal(result, 'removed');
    assert.equal(existsSync(lock), false);
  });

  it('keeps a lock younger than the limit: a git command may be writing the index', async () => {
    const result = await removeStaleIndexLock(dir.path, {
      maxAgeMs: 60_000,
      now: () => written + 59_000,
    });
    assert.equal(result, 'fresh');
    assert.equal(existsSync(lock), true);
  });

  it('has a limit of a minute by default', async () => {
    assert.equal(await removeStaleIndexLock(dir.path, { now: () => written + 59_000 }), 'fresh');
    assert.equal(await removeStaleIndexLock(dir.path, { now: () => written + 60_000 }), 'removed');
  });

  it('measures the age from the last write, by the real clock by default', async () => {
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lock, old, old);
    assert.equal(await removeStaleIndexLock(dir.path), 'removed');
  });

  it('removes a read-only lock', async () => {
    chmodSync(lock, 0o444);
    assert.equal(await removeStaleIndexLock(dir.path, { now: () => written + 120_000 }), 'removed');
    assert.equal(existsSync(lock), false);
  });

  it('answers none when there is no lock', async () => {
    dir.remove();
    assert.equal(await removeStaleIndexLock(dir.path, { now: () => written + 120_000 }), 'none');
  });

  // Windows answers ENOENT for a path through a file, so the error shows only elsewhere.
  it('fails when the lock cannot be checked', { skip: process.platform === 'win32' }, async () => {
    await assert.rejects(removeStaleIndexLock(lock), { code: 'ENOTDIR' });
  });
});
