// git's unified diff as the red proof and the testsUnchanged guard read it (ADR 0078): the lines
// each file gained and lost, by its path before and after.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDiff } from '../../src/formats/unified-diff.ts';

describe('parseDiff', () => {
  it('reads an added, a changed and a deleted file', () => {
    const diff = [
      'diff --git a/test/add.test.mjs b/test/add.test.mjs',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/test/add.test.mjs',
      '@@ -0,0 +1,2 @@',
      "+test('adds', () => {",
      '+  assert.equal(add(1, 2), 3);',
      'diff --git a/src/add.mjs b/src/add.mjs',
      'index 2222222..3333333 100644',
      '--- a/src/add.mjs',
      '+++ b/src/add.mjs',
      '@@ -1 +1 @@',
      "-export const add = () => { throw new Error('not implemented'); };",
      '+export const add = (a, b) => a + b;',
      '\\ No newline at end of file',
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      '',
    ].join('\n');
    assert.deepEqual(parseDiff(diff), [
      {
        newPath: 'test/add.test.mjs',
        added: ["test('adds', () => {", '  assert.equal(add(1, 2), 3);'],
        removed: [],
      },
      {
        oldPath: 'src/add.mjs',
        newPath: 'src/add.mjs',
        added: ['export const add = (a, b) => a + b;'],
        removed: ["export const add = () => { throw new Error('not implemented'); };"],
      },
      { oldPath: 'old.txt', added: [], removed: ['gone'] },
    ]);
  });

  it('reads lines that look like headers inside a hunk as content', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      '---- a removed line that starts with ---',
      '++++ an added line that starts with +++',
      ' context',
      '',
    ].join('\n');
    assert.deepEqual(parseDiff(diff), [
      {
        oldPath: 'a.txt',
        newPath: 'a.txt',
        added: ['+++ an added line that starts with +++'],
        removed: ['--- a removed line that starts with ---'],
      },
    ]);
  });

  it('reads quoted paths, a binary file, and CRLF content as it is', () => {
    const diff = [
      'diff --git "a/sp\\303\\251cial \\"q\\".txt" "b/sp\\303\\251cial \\"q\\".txt"',
      '--- "a/sp\\303\\251cial \\"q\\".txt"',
      '+++ "b/sp\\303\\251cial \\"q\\".txt"',
      '@@ -1 +1 @@',
      '-old\r',
      '+new\ttab\r',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    assert.deepEqual(parseDiff(diff), [
      {
        oldPath: 'spécial "q".txt',
        newPath: 'spécial "q".txt',
        added: ['new\ttab\r'],
        removed: ['old\r'],
      },
      { added: [], removed: [] },
    ]);
  });

  it('reads nothing from an empty diff', () => {
    assert.deepEqual(parseDiff(''), []);
  });
});
