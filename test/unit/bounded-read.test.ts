// The bounded, link-safe file reader on the real file system: links, junctions and hard links are
// made with node:fs, so no process starts (ADR 0021).

import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readOutDocFile } from '../../src/platform/bounded-read.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

/**
 * A rename that tries again for a moment: on Windows a scanner may still hold a file just written
 * in the folder, and the rename fails with EPERM, EACCES or EBUSY until it lets go.
 */
const renameRetrying = (from: string, to: string): void => {
  for (let tries = 1; ; tries += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (tries >= 50 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
};

describe('readOutDocFile', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('out-doc');
  });
  afterEach(() => dir.remove());

  it('reads an out doc within its limit', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'é done');
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'text',
      text: 'é done',
    });
  });

  it('says when there is none', () => {
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), { kind: 'missing' });
  });

  // Review of #629: the limit is the most it reads, not one byte past it.
  it('reads an out doc of exactly its limit', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'x'.repeat(100));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'text',
      text: 'x'.repeat(100),
    });
  });

  it('does not read an out doc past its limit', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'x'.repeat(101));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'unread',
      reason: 'it is larger than 100 bytes',
    });
  });

  it('does not read what is not a regular file', () => {
    mkdirSync(join(dir.path, 'plan.md'));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'unread',
      reason: 'it is not a regular file',
    });
  });

  // A link in a folder of the path (a junction, which needs no privilege) leads out as well.
  // A hard link keeps its name inside the worktree but its content may be any file of the volume.
  // #134: the file opened must be the file checked, not one swapped in between.
  // Review of #136: a folder swapped for a link between the check and the open is followed by
  // the open and by any later look at the same path; only the identity taken at the check holds.
  it('does not read the file behind a folder swapped in after the check', () => {
    const worktree = join(dir.path, 'worktree');
    mkdirSync(join(worktree, 'docs'), { recursive: true });
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(worktree, 'docs', 'plan.md'), 'the out doc');
    writeFileSync(join(dir.path, 'outside', 'plan.md'), 'not for the log');
    const swapping = (path: string, flags: number): number => {
      renameRetrying(join(worktree, 'docs'), join(worktree, 'docs-before'));
      symlinkSync(join(dir.path, 'outside'), join(worktree, 'docs'), 'junction');
      return openSync(path, flags);
    };
    assert.deepEqual(readOutDocFile(join(worktree, 'docs', 'plan.md'), 100, worktree, swapping), {
      kind: 'unread',
      reason: 'it changed while it was read',
    });
  });

  // Review of #136: a swap after the containment check but before the identity is taken is seen
  // once more after the open, when the real path no longer is the one checked.
  it('does not read the file behind a folder swapped in before its identity was taken', () => {
    const worktree = join(dir.path, 'worktree');
    mkdirSync(join(worktree, 'docs'), { recursive: true });
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(worktree, 'docs', 'plan.md'), 'the out doc');
    writeFileSync(join(dir.path, 'outside', 'plan.md'), 'not for the log');
    const swapping = (path: string, options: { bigint: true }) => {
      renameRetrying(join(worktree, 'docs'), join(worktree, 'docs-before'));
      symlinkSync(join(dir.path, 'outside'), join(worktree, 'docs'), 'junction');
      return statSync(path, options);
    };
    const file = join(worktree, 'docs', 'plan.md');
    assert.deepEqual(readOutDocFile(file, 100, worktree, openSync, swapping), {
      kind: 'unread',
      reason: 'it changed while it was read',
    });
  });

  it('does not read a file other than the one it checked', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'the out doc');
    writeFileSync(join(dir.path, 'swapped.md'), 'not for the log');
    const swapped = (_path: string, flags: number): number =>
      openSync(join(dir.path, 'swapped.md'), flags);
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path, swapped), {
      kind: 'unread',
      reason: 'it changed while it was read',
    });
  });

  it('does not read an out doc that has more than one link', () => {
    writeFileSync(join(dir.path, 'secret.txt'), 'not for the log');
    linkSync(join(dir.path, 'secret.txt'), join(dir.path, 'plan.md'));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'unread',
      reason: 'it has more than one link',
    });
  });

  it('does not read an out doc outside the worktree, through a linked folder or ..', () => {
    const worktree = join(dir.path, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(dir.path, 'outside', 'plan.md'), 'not for the log');
    symlinkSync(join(dir.path, 'outside'), join(worktree, 'out'), 'junction');
    for (const file of [
      join(worktree, 'out', 'plan.md'),
      join(worktree, '..', 'outside', 'plan.md'),
    ]) {
      assert.deepEqual(
        readOutDocFile(file, 100, worktree),
        {
          kind: 'unread',
          reason: 'it is outside the worktree',
        },
        file,
      );
    }
  });

  // ADR 0047: a link could point the out doc, and so the event log, at any file.
  it('does not read an out doc that is a link to a file', (t) => {
    writeFileSync(join(dir.path, 'secret.txt'), 'not for the log');
    try {
      symlinkSync(join(dir.path, 'secret.txt'), join(dir.path, 'plan.md'), 'file');
    } catch {
      // Windows makes a link to a file only with a privilege the test may not have.
      t.skip('cannot make a link to a file here');
      return;
    }
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'unread',
      reason: 'it is not a regular file',
    });
  });
});
