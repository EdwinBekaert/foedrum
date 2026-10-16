// realPath on the real file system: links and junctions are made with node:fs, so no process
// starts (ADR 0021). Short names need cmd.exe to find them, so they are in
// test/integration/read-guard.test.ts.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { realPath } from '../../src/platform/real-path.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const windows = process.platform === 'win32';

describe('realPath', () => {
  let dir: TempDir;
  let base: string;
  let outside: string;
  before(() => {
    dir = makeTempDir('real-path');
    base = realpathSync.native(dir.path);
    outside = join(base, 'outside');
    mkdirSync(join(base, 'inside', 'src'), { recursive: true });
    mkdirSync(join(outside, 'gh'), { recursive: true });
    writeFileSync(join(base, 'inside', 'a.txt'), 'a');
    writeFileSync(join(outside, 'gh', 'hosts.yml'), 'secret');
    // A junction on Windows, which needs no privilege; a directory link elsewhere.
    symlinkSync(join(outside, 'gh'), join(base, 'inside', 'link'), windows ? 'junction' : 'dir');
  });
  after(() => dir.remove());

  it('returns an existing path as it is', () => {
    assert.equal(realPath(join(base, 'inside', 'a.txt')), join(base, 'inside', 'a.txt'));
  });

  it('resolves the deepest existing parent and appends the rest', () => {
    assert.equal(
      realPath(join(base, 'inside', 'link', 'new', 'file.txt')),
      join(outside, 'gh', 'new', 'file.txt'),
    );
  });

  it('follows a link or junction to its target', () => {
    assert.equal(
      realPath(join(base, 'inside', 'link', 'hosts.yml')),
      join(outside, 'gh', 'hosts.yml'),
    );
  });

  it('appends the rest below a file that is not a folder', () => {
    assert.equal(realPath(join(base, 'inside', 'a.txt', 'x')), join(base, 'inside', 'a.txt', 'x'));
  });

  // The operating system's own reading of `link/..`: Windows drops `link\..` before it looks at
  // the disk, while POSIX goes to the target's parent.
  it('reads .. after a link the way the operating system does', () => {
    const raw = `${join(base, 'inside', 'link')}${windows ? '\\' : '/'}..${windows ? '\\' : '/'}a.txt`;
    assert.equal(realPath(raw), windows ? join(base, 'inside', 'a.txt') : join(outside, 'a.txt'));
  });

  it('gives the case of the disk on Windows', { skip: !windows }, () => {
    assert.equal(
      realPath(join(base, 'INSIDE', 'SRC', 'New.ts')),
      join(base, 'inside', 'src', 'New.ts'),
    );
  });

  it('throws what is not a missing part', () => {
    const failing = (path: string): string => {
      throw Object.assign(new Error(`EACCES: permission denied, ${path}`), { code: 'EACCES' });
    };
    assert.throws(() => realPath(join(base, 'inside', 'a.txt'), failing), /EACCES/);
  });

  // A missing drive: the root's own error, at once.
  it('throws when not even the root exists', () => {
    const alwaysMissing = (): string => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    };
    assert.throws(() => realPath(join(base, 'x'), alwaysMissing), /ENOENT/);
  });

  it('stops at the first part that exists, from the end', () => {
    const asked: string[] = [];
    const missingBelowBase = (path: string): string => {
      asked.push(path);
      if (path.length > base.length) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return base;
    };
    assert.equal(realPath(join(base, 'x', 'y'), missingBelowBase), join(base, 'x', 'y'));
    assert.deepEqual(asked, [join(base, 'x', 'y'), join(base, 'x'), base]);
  });
});
