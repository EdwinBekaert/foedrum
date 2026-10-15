import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearReadOnly, type RemovePath, removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const errorWithCode = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code });

// A removePath that fails with the given codes, in order, and then succeeds.
const failingThen = (codes: string[]) => {
  const calls: string[] = [];
  const removePath: RemovePath = async (path) => {
    calls.push(path);
    const code = codes[calls.length - 1];
    if (code !== undefined) throw errorWithCode(code);
  };
  return { calls, removePath };
};

const recordSleeps = () => {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
    },
  };
};

const isWritable = (path: string): boolean => (statSync(path).mode & 0o200) !== 0;

describe('clearReadOnly', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('remove');
  });
  afterEach(() => dir.remove());

  it('makes a read-only folder, its subfolders and their files writable', async () => {
    const top = join(dir.path, 'top');
    const sub = join(top, 'sub');
    const file = join(sub, 'file.txt');
    mkdirSync(sub, { recursive: true });
    writeFileSync(file, 'x');
    for (const path of [file, sub, top]) chmodSync(path, 0o555);

    await clearReadOnly(top);

    for (const path of [top, sub, file]) assert.ok(isWritable(path), `${path} is writable`);
  });

  it('accepts a path that does not exist', async () => {
    await clearReadOnly(join(dir.path, 'missing'));
  });

  it('leaves the target of a symbolic link inside the tree alone', async (t) => {
    const outside = join(dir.path, 'outside.txt');
    const top = join(dir.path, 'top');
    writeFileSync(outside, 'x');
    chmodSync(outside, 0o444);
    mkdirSync(top);
    try {
      symlinkSync(outside, join(top, 'link'), 'file');
    } catch {
      t.skip('this account cannot create symbolic links');
      return;
    }

    await clearReadOnly(top);

    assert.equal(isWritable(outside), false);
    chmodSync(outside, 0o666);
  });
});

describe('removeTree', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('remove');
  });
  afterEach(() => dir.remove());

  it('removes a folder whose folders and files are read-only', async () => {
    const top = join(dir.path, 'top');
    const sub = join(top, 'sub');
    const file = join(sub, 'file.txt');
    mkdirSync(sub, { recursive: true });
    writeFileSync(file, 'x');
    for (const path of [file, sub, top]) chmodSync(path, 0o555);

    await removeTree(top);

    assert.equal(existsSync(top), false);
  });

  it('accepts a path that does not exist', async () => {
    await removeTree(join(dir.path, 'missing'));
  });

  for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
    it(`retries ${code} with a growing delay until the delete succeeds`, async () => {
      const { calls, removePath } = failingThen([code, code]);
      const { sleeps, sleep } = recordSleeps();

      await removeTree(join(dir.path, 'busy'), { removePath, sleep, delayMs: 10 });

      assert.equal(calls.length, 3);
      assert.deepEqual(sleeps, [10, 20]);
    });
  }

  it('gives up after the last attempt and throws the last error', async () => {
    const { calls, removePath } = failingThen(['EBUSY', 'EPERM', 'ENOTEMPTY']);
    const { sleeps, sleep } = recordSleeps();

    await assert.rejects(
      removeTree(join(dir.path, 'busy'), { removePath, sleep, attempts: 3, delayMs: 5 }),
      { code: 'ENOTEMPTY' },
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [5, 10]);
  });

  it('does not retry other errors', async () => {
    const { calls, removePath } = failingThen(['EACCES']);
    const { sleeps, sleep } = recordSleeps();

    await assert.rejects(removeTree(join(dir.path, 'denied'), { removePath, sleep }), {
      code: 'EACCES',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });
});
