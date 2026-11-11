// The cleanup's sweep of the Brewery's `.foedrum/tmp/` (ADR 0380): what nothing changed in for 2
// days goes, and a folder a session still writes in stays.

import assert from 'node:assert/strict';
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { sweepTemp, TEMP_AGE_MS } from '../../src/engine/temp-sweep.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const now = new Date('2026-11-11T12:00:00.000Z');
const ago = (ms: number): Date => new Date(now.getTime() - ms);
const hour = 60 * 60 * 1000;

describe('sweepTemp', () => {
  let dir: TempDir;
  let tmp: string;
  beforeEach(() => {
    dir = makeTempDir('temp-sweep');
    tmp = join(dir.path, '.foedrum', 'tmp');
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => dir.remove());

  /** Writes `path` under the folder, last changed at `when`, its folders too. */
  const file = (path: string, when: Date): void => {
    const at = join(tmp, ...path.split('/'));
    mkdirSync(join(at, '..'), { recursive: true });
    writeFileSync(at, 'scratch\n');
    utimesSync(at, when, when);
  };
  const touchFolder = (path: string, when: Date): void => {
    utimesSync(join(tmp, ...path.split('/')), when, when);
  };

  it('the cleanup removes a temporary file older than 2 days', async () => {
    file('old.txt', ago(TEMP_AGE_MS + hour));
    file('new.txt', ago(TEMP_AGE_MS - hour));

    const report = await sweepTemp(tmp, now);

    assert.deepStrictEqual(report, { removed: ['old.txt'], failed: [] });
    assert.equal(existsSync(join(tmp, 'old.txt')), false);
    assert.equal(existsSync(join(tmp, 'new.txt')), true);
  });

  it('removes a folder whose every file and folder is older than 2 days', async () => {
    file('921/run/log.txt', ago(TEMP_AGE_MS + 2 * hour));
    touchFolder('921/run', ago(TEMP_AGE_MS + 2 * hour));
    touchFolder('921', ago(TEMP_AGE_MS + 2 * hour));

    assert.deepStrictEqual(await sweepTemp(tmp, now), { removed: ['921'], failed: [] });
    assert.equal(existsSync(join(tmp, '921')), false);
  });

  it("keeps a folder in which one file changed in the last 2 days, as a running session's", async () => {
    file('921/old.txt', ago(TEMP_AGE_MS + hour));
    file('921/deep/live.txt', ago(hour));
    touchFolder('921/deep', ago(TEMP_AGE_MS + hour));
    touchFolder('921', ago(TEMP_AGE_MS + hour));

    assert.deepStrictEqual(await sweepTemp(tmp, now), { removed: [], failed: [] });
    assert.equal(existsSync(join(tmp, '921', 'old.txt')), true);
  });

  it('reports an entry it cannot remove and still removes the others: regression test', async () => {
    file('a.txt', ago(TEMP_AGE_MS + hour));
    file('b.txt', ago(TEMP_AGE_MS + hour));
    const remove = async (path: string): Promise<void> => {
      if (path.endsWith('a.txt')) throw new Error('EBUSY: the file is open');
      rmSync(path);
    };

    assert.deepStrictEqual(await sweepTemp(tmp, now, remove), {
      removed: ['b.txt'],
      failed: [{ name: 'a.txt', error: 'EBUSY: the file is open' }],
    });
    assert.equal(existsSync(join(tmp, 'a.txt')), true);
  });

  it('reads a link as itself and removes it without touching what it points at: regression test', async () => {
    const outside = join(dir.path, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'live.txt'), 'kept\n');
    const link = join(tmp, 'link');
    symlinkSync(outside, link, 'junction');
    const old = ago(TEMP_AGE_MS + hour);
    lutimesSync(link, old, old);

    assert.deepStrictEqual(await sweepTemp(tmp, now), { removed: ['link'], failed: [] });
    assert.equal(existsSync(join(outside, 'live.txt')), true);
  });

  it('removes nothing when the folder is missing', async () => {
    assert.deepStrictEqual(await sweepTemp(join(dir.path, 'missing'), now), {
      removed: [],
      failed: [],
    });
  });
});
