// The test report files of the real file system (ADR 0078): cleared through the platform's
// removal, only inside the worktree, before the test check runs.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileReports } from '../../src/checks/check-runner.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('fileReports', () => {
  let dir: TempDir;
  let worktree: string;
  beforeEach(() => {
    dir = makeTempDir('report-files');
    worktree = join(dir.path, 'worktree');
    mkdirSync(worktree);
  });
  afterEach(() => dir.remove());

  it('clears a report file, and a folder at the report path', async () => {
    const file = join(worktree, 'junit.xml');
    writeFileSync(file, '<testsuites/>');
    await fileReports.clear(file, worktree);
    assert.equal(existsSync(file), false);
    const folder = join(worktree, 'results.xml');
    mkdirSync(folder);
    writeFileSync(join(folder, 'left.txt'), 'x');
    await fileReports.clear(folder, worktree);
    assert.equal(existsSync(folder), false);
    // Nothing there is nothing to clear.
    await fileReports.clear(join(worktree, 'none', 'junit.xml'), worktree);
  });

  it('refuses to clear through a linked folder that leads out of the worktree', async () => {
    const outside = join(dir.path, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'junit.xml'), 'keep');
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(outside, join(worktree, 'reports'), 'junction');
    await assert.rejects(
      async () => fileReports.clear(join(worktree, 'reports', 'junit.xml'), worktree),
      /outside the worktree/,
    );
    assert.equal(existsSync(join(outside, 'junit.xml')), true);
  });
});
