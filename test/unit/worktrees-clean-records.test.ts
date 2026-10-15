import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readRecords } from '../../scripts/worktrees-clean/records.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('readRecords', () => {
  let dir: TempDir;
  let common: string;
  const record = (name: string, files: Record<string, string> = {}): string => {
    const path = join(common, 'worktrees', name);
    mkdirSync(path, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
    return path;
  };
  beforeEach(() => {
    dir = makeTempDir('records');
    common = join(dir.path, '.git');
  });
  afterEach(() => dir.remove());

  it('reads the folder, whether it exists and the lock of every record', async () => {
    const there = join(dir.path, 'there');
    mkdirSync(there);
    const gone = join(dir.path, 'gone');
    record('there', { gitdir: `${there}/.git\n` });
    // worktree.useRelativePaths writes the gitdir relative to the record.
    record('relative', { gitdir: '../../../gone/.git\r\n', locked: 'initializing\n' });
    record('missing', { locked: '' });
    record('crlf', { gitdir: `${there}/.git\r\n`, locked: 'claude session x (pid 7)\r\n' });
    record('empty', { gitdir: '\n' });
    writeFileSync(join(common, 'worktrees', 'stray-file'), 'not a record\n');

    const records = await readRecords(common);

    const byName = new Map(records.map((fact) => [fact.name, fact]));
    assert.deepEqual([...byName.keys()].sort(), ['crlf', 'empty', 'missing', 'relative', 'there']);
    assert.equal(byName.get('crlf')?.lockReason, 'claude session x (pid 7)');
    assert.equal(byName.get('crlf')?.folder, there);
    assert.deepEqual(byName.get('there'), {
      dir: join(common, 'worktrees', 'there'),
      name: 'there',
      folder: there,
      folderExists: true,
      lockReason: undefined,
    });
    assert.deepEqual(byName.get('relative'), {
      dir: join(common, 'worktrees', 'relative'),
      name: 'relative',
      folder: gone,
      folderExists: false,
      lockReason: 'initializing',
    });
    assert.equal(byName.get('missing')?.folder, undefined);
    assert.equal(byName.get('missing')?.folderExists, false);
    assert.equal(byName.get('missing')?.lockReason, '');
    assert.equal(byName.get('empty')?.folder, undefined);
  });

  it('finds no records when there is no worktrees folder', async () => {
    assert.deepEqual(await readRecords(common), []);
  });
});
