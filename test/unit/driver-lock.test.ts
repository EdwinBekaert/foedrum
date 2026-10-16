// The driver lock and the work root's Brewery marker (ADR 0037). Two locks in one process stand
// for two Foedrum processes: SQLite keeps the locks of its connections apart within a process as
// between processes. That a lock is free once its process dies is in
// test/integration/driver-lock.test.ts.

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  type DriverLock,
  type DriverLockOptions,
  DriverRunningError,
  lockDriver,
  OtherBreweryError,
} from '../../src/engine/driver-lock.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const startedAt = new Date('2026-10-16T12:00:00.000Z');
const cellar: DriverLockOptions = {
  brewery: 'acme/brewery',
  owner: 'cellar',
  pid: 4242,
  now: () => startedAt,
  // Refused at once: the wait for a lock a dead process still holds is in the integration test.
  waitMs: 0,
};

describe('lockDriver', () => {
  let dir: TempDir;
  let workRoot: string;
  let locks: DriverLock[];
  const lock = (options: DriverLockOptions = cellar): DriverLock => {
    const taken = lockDriver(workRoot, options);
    locks.push(taken);
    return taken;
  };
  const json = (...path: string[]): unknown =>
    JSON.parse(readFileSync(join(workRoot, ...path), 'utf8'));

  beforeEach(() => {
    dir = makeTempDir('driver-lock');
    workRoot = join(dir.path, 'work');
    locks = [];
  });
  afterEach(() => {
    for (const taken of locks) taken.release();
    dir.remove();
  });

  it('takes the lock in a new work root, which then records its Brewery and the holder', () => {
    const taken = lock();
    assert.equal(taken.held, true);
    assert.equal(taken.owner, 'cellar');
    assert.equal(taken.path, join(workRoot, 'drivers', 'cellar.lock'));
    assert.deepStrictEqual(json('brewery.json'), { brewery: 'acme/brewery' });
    assert.deepStrictEqual(json('drivers', 'cellar.holder.json'), {
      pid: 4242,
      startedAt: startedAt.toISOString(),
    });
  });

  it('refuses a second process of the same driver while the first holds the lock, naming it', () => {
    const first = lock();
    assert.throws(
      () => lock({ ...cellar, pid: 5151 }),
      (error: unknown) =>
        error instanceof DriverRunningError &&
        error.path === first.path &&
        error.holder?.pid === 4242 &&
        error.message.includes(`process 4242, started at ${startedAt.toISOString()}`),
    );
    assert.equal(first.held, true);
  });

  it('lets the other drivers of the same Brewery run beside it', () => {
    lock();
    const session = lock({ ...cellar, owner: 'session-7' });
    assert.equal(session.held, true);
  });

  it('leaves only the marker and the drivers in the work root, for the first driver and the next', () => {
    lock();
    lock({ ...cellar, owner: 'session-7' });
    assert.deepStrictEqual(readdirSync(workRoot).sort(), ['brewery.json', 'drivers']);
  });

  it('refuses a second process without naming a holder when the holder file is gone', () => {
    lock();
    rmSync(join(workRoot, 'drivers', 'cellar.holder.json'));
    assert.throws(
      () => lock({ ...cellar, pid: 5151 }),
      (error: unknown) =>
        error instanceof DriverRunningError &&
        error.holder === undefined &&
        !error.message.includes('by process') &&
        error.message.includes('is held. Stop it first'),
    );
  });

  it('refuses a driver of another Brewery, also once every driver of the first has stopped', () => {
    lock().release();
    assert.throws(
      () => lock({ ...cellar, brewery: 'other/brewery' }),
      (error: unknown) =>
        error instanceof OtherBreweryError &&
        error.brewery === 'acme/brewery' &&
        error.marker === join(workRoot, 'brewery.json'),
    );
    assert.deepStrictEqual(json('brewery.json'), { brewery: 'acme/brewery' });
  });

  it('takes the Brewery of the marker whatever its case, as GitHub does', () => {
    lock().release();
    assert.equal(lock({ ...cellar, brewery: 'Acme/Brewery' }).held, true);
  });

  it('takes a marker that records the Brewery in another case than this driver names it', () => {
    lock({ ...cellar, brewery: 'Acme/Brewery' }).release();
    assert.deepStrictEqual(json('brewery.json'), { brewery: 'Acme/Brewery' });
    assert.equal(lock({ ...cellar, brewery: 'acme/brewery' }).held, true);
  });

  it('can be taken again once released, and a second release does nothing', () => {
    const first = lock();
    first.release();
    assert.equal(first.held, false);
    first.release();
    assert.equal(lock({ ...cellar, pid: 5151 }).held, true);
    assert.deepStrictEqual(json('drivers', 'cellar.holder.json'), {
      pid: 5151,
      startedAt: startedAt.toISOString(),
    });
  });

  it('refuses an owner that is not one path segment, and a Brewery that is no owner/name', () => {
    assert.throws(() => lock({ ...cellar, owner: '../cellar' }), /one path segment/);
    assert.throws(() => lock({ ...cellar, brewery: 'brewery' }), /no owner\/name/);
  });

  it('refuses a work root whose marker cannot be read, and leaves the marker as it is', () => {
    lock().release();
    writeFileSync(join(workRoot, 'brewery.json'), 'not json');
    assert.throws(() => lock(), /cannot be read/);
    assert.equal(readFileSync(join(workRoot, 'brewery.json'), 'utf8'), 'not json');
  });

  it('reads a marker saved with a byte order mark and CRLF, as a Windows editor may save it', () => {
    lock().release();
    writeFileSync(join(workRoot, 'brewery.json'), '\uFEFF{ "brewery": "acme/brewery" }\r\n');
    assert.equal(lock().held, true);
  });

  it('refuses a marker that is not exactly a Brewery: another field, or no owner/name', () => {
    lock().release();
    const marker = join(workRoot, 'brewery.json');
    writeFileSync(marker, JSON.stringify({ brewery: 'acme/brewery', extra: 1 }));
    assert.throws(() => lock(), /cannot be read/);
    writeFileSync(marker, JSON.stringify({ brewery: 'acme' }));
    assert.throws(() => lock(), /cannot be read/);
  });

  it('lets its lock go when the holder file cannot be written, so a later try can take it', () => {
    const holder = join(workRoot, 'drivers', 'cellar.holder.json');
    mkdirSync(join(holder, 'in-the-way'), { recursive: true });
    // The write fails because a folder is in the way (EISDIR, or EPERM on Windows).
    assert.throws(
      () => lock(),
      (error: unknown) =>
        !(error instanceof DriverRunningError) &&
        ['EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''),
    );
    rmSync(holder, { recursive: true });
    assert.equal(lock().held, true);
  });

  it('lets its lock go on release even when the holder file cannot be removed', () => {
    const first = lock();
    const holder = join(workRoot, 'drivers', 'cellar.holder.json');
    rmSync(holder);
    mkdirSync(join(holder, 'in-the-way'), { recursive: true });
    assert.doesNotThrow(() => first.release());
    assert.equal(first.held, false);
    rmSync(holder, { recursive: true });
    assert.equal(lock({ ...cellar, pid: 5151 }).held, true);
  });
});
