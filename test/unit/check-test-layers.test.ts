import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkTestLayer, checkTestLayers } from '../../scripts/check-test-layers.ts';

// Source files that are scanned, never run (see the README in the folder).
const fixtures = join(import.meta.dirname, '..', 'fixtures', 'test-layers');
const clean = join(fixtures, 'clean');
const spawning = join(fixtures, 'spawning');
// A test/ folder in miniature: every subfolder but unit/ has a file that imports child_process.
const testDir = join(fixtures, 'test-dir');

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

describe('checkTestLayers', () => {
  it('reports imports in property/, chaos/ and helpers/, relative to the test folder', () => {
    const problems = checkTestLayers(testDir, none);
    assert.deepEqual(
      problems.map(({ file }) => file),
      ['chaos/spawns.test.ts', 'helpers/real-runner.ts', 'property/spawns.test.ts'],
    );
    for (const { problem } of problems) assert.match(problem, /imports child_process/);
  });

  it('leaves out exceptions and reports stale ones, by path relative to the test folder', () => {
    const exceptions = new Map([
      ['helpers/real-runner.ts', 'a reason'],
      ['unit/pure.test.ts', 'no longer needed'],
    ]);
    assert.deepEqual(
      checkTestLayers(testDir, exceptions).map(({ file, problem }) => [
        file,
        /exception list/.test(problem),
      ]),
      [
        ['chaos/spawns.test.ts', false],
        ['property/spawns.test.ts', false],
        ['unit/pure.test.ts', true],
      ],
    );
  });
});

// The real process runner starts processes without the file importing child_process (#12).
describe('checkTestLayer and the real process runner', () => {
  const runner = join(fixtures, 'runner');
  const runnerFiles = [
    'dynamic-import.test.ts',
    'exec-import.test.ts',
    'helpers/re-export.ts',
    'helpers/star-re-export.ts',
    'named-import.test.ts',
    'namespace.test.ts',
    'require.test.cjs',
    'script-runner.test.ts',
  ];

  it('reports every file that imports spawnProcess or execProcess, in any form and folder', () => {
    const problems = checkTestLayer(runner, none);
    assert.deepEqual(
      problems.map(({ file }) => file),
      runnerFiles,
    );
    for (const { problem } of problems) {
      assert.match(problem, /imports the real process runner/);
      assert.match(problem, /fake/);
      assert.match(problem, /test\/integration\//);
    }
  });

  it('leaves out files that import only types, the runner with a fake spawner or other helpers', () => {
    assert.deepEqual(checkTestLayer(join(runner, 'clean'), none), []);
  });

  it('reports an exception for a file that imports neither child_process nor the runner', () => {
    const exceptions = new Map([['clean/fake-spawner.test.ts', 'no longer needed']]);
    const stale = checkTestLayer(runner, exceptions).filter(({ file }) => exceptions.has(file));
    assert.equal(stale.length, 1);
    assert.match(stale[0]?.problem ?? '', /exception list/);
  });

  it('leaves out the files on the exception list, which are then not stale', () => {
    const exceptions = new Map([['namespace.test.ts', 'a reason']]);
    assert.deepEqual(
      checkTestLayer(runner, exceptions).map(({ file }) => file),
      runnerFiles.filter((file) => file !== 'namespace.test.ts'),
    );
  });
});
