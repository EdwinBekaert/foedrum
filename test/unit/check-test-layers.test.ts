import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkTestLayer } from '../../scripts/check-test-layers.ts';

// Source files that are scanned, never run (see the README in the folder).
const fixtures = join(import.meta.dirname, '..', 'fixtures', 'test-layers');
const clean = join(fixtures, 'clean');
const spawning = join(fixtures, 'spawning');

const none: ReadonlyMap<string, string> = new Map();

const spawningFiles = [
  'bare-specifier.test.ts',
  'dynamic-import.test.ts',
  'helpers/re-export.ts',
  'named-import.test.ts',
  'nested/side-effect.test.mts',
  'require.test.cjs',
];

describe('checkTestLayer', () => {
  it('reports nothing for a folder whose files do not import child_process', () => {
    assert.deepEqual(checkTestLayer(clean, none), []);
  });

  it('reports every source file that imports child_process, in any form and folder', () => {
    const problems = checkTestLayer(spawning, none);
    assert.deepEqual(
      problems.map(({ file }) => file),
      spawningFiles,
    );
    for (const { problem } of problems) {
      assert.match(problem, /imports child_process/);
      assert.match(problem, /test\/integration\//);
    }
  });

  it('leaves out the files on the exception list', () => {
    const exceptions = new Map([
      ['require.test.cjs', 'a reason'],
      ['nested/side-effect.test.mts', 'another reason'],
    ]);
    assert.deepEqual(
      checkTestLayer(spawning, exceptions).map(({ file }) => file),
      spawningFiles.filter((file) => !exceptions.has(file)),
    );
  });

  it('reports an exception for a file that does not import child_process or does not exist', () => {
    const exceptions = new Map([
      ['pure.test.ts', 'no longer needed'],
      ['gone.test.ts', 'file was moved'],
    ]);
    const stale = checkTestLayer(spawning, exceptions).filter(({ file }) => exceptions.has(file));
    assert.deepEqual(
      stale.map(({ file }) => file),
      ['gone.test.ts', 'pure.test.ts'],
    );
    for (const { problem } of stale) {
      assert.match(problem, /exception list.*does not import child_process/);
    }
  });
});
