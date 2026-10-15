import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Rename, replaceFile } from '../../src/platform/replace-file.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const failing = (code: string) => Object.assign(new Error(code), { code });

/** A rename that fails with `codes` in turn, then succeeds; records calls and sleeps. */
const scripted = (codes: string[]) => {
  const calls: [string, string][] = [];
  const sleeps: number[] = [];
  const rename: Rename = async (from, to) => {
    calls.push([from, to]);
    const code = codes.shift();
    if (code !== undefined) throw failing(code);
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { calls, sleeps, rename, sleep };
};

describe('replaceFile', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('replace-file');
  });
  afterEach(() => dir.remove());

  it('renames a file over another', async () => {
    const from = join(dir.path, 'new');
    const to = join(dir.path, 'old');
    writeFileSync(from, 'new\n');
    writeFileSync(to, 'old\n');
    await replaceFile(from, to);
    assert.equal(readFileSync(to, 'utf8'), 'new\n');
  });

  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`retries ${code} with a growing delay`, async () => {
      const s = scripted([code, code]);
      await replaceFile('a', 'b', { rename: s.rename, sleep: s.sleep, delayMs: 10 });
      assert.equal(s.calls.length, 3);
      assert.deepEqual(s.sleeps, [10, 20]);
    });
  }

  it('gives up after the last attempt with the last error', async () => {
    const s = scripted(['EBUSY', 'EBUSY', 'EBUSY']);
    await assert.rejects(
      replaceFile('a', 'b', { rename: s.rename, sleep: s.sleep, attempts: 3 }),
      /EBUSY/,
    );
    assert.equal(s.calls.length, 3);
  });

  it('does not retry other errors', async () => {
    const s = scripted(['ENOENT']);
    await assert.rejects(replaceFile('a', 'b', { rename: s.rename, sleep: s.sleep }), /ENOENT/);
    assert.equal(s.calls.length, 1);
  });
});
