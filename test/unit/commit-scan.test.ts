// The secret scan of a batch's commits (ADR 0079), the pure core: findings in the messages and the
// added lines of git's output, each naming the commit, the place and the kind, never the text.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  commitCandidates,
  MESSAGE,
  scanMessages,
  scanPatches,
} from '../../src/formats/commit-scan.ts';

// Built at run time, so no scanner takes this file for one that holds a token.
const token = ['ghp', 'A1b2'.repeat(9)].join('_');
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const none = () => false;

/** `git log --format=%x00%H --patch --unified=0` output of one commit. */
const patch = (commit: string, ...files: string[]): string =>
  [`\0${commit}`, '', ...files].join('\n');
const newFile = (path: string, ...lines: string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');

describe('scanMessages', () => {
  it('names the commit whose message holds a secret, and the kind, never the text', () => {
    const log = `\0${C1}\nAdd the flag\n\n\0${C2}\nUse the key\n\nGH=${token}\n\n`;
    const found = scanMessages(log, none);
    assert.deepEqual(found, [{ commit: C2, place: MESSAGE, kind: 'GitHub token' }]);
    assert.doesNotMatch(JSON.stringify(found), /A1b2|ghp_/);
  });

  it('finds nothing in clean messages', () => {
    assert.deepEqual(scanMessages(`\0${C1}\nAdd the flag\n\nIt prints JSON.\n\n`, none), []);
  });

  it('leaves out a commit hash the clone has, and keeps a hexadecimal key it does not', () => {
    const log = `\0${C1}\nRevert ${'a'.repeat(40)}\n\nkey ${'b'.repeat(40)}\n`;
    const found = scanMessages(log, (sha) => sha === 'a'.repeat(40));
    assert.deepEqual(found, [{ commit: C1, place: MESSAGE, kind: 'long hexadecimal string' }]);
  });
});

describe('scanPatches', () => {
  it('names the commit and the file of an added line that holds a secret', () => {
    const log = patch(
      C1,
      [
        'diff --git a/src/app.ts b/src/app.ts',
        'index 1111111..2222222 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -3 +3,2 @@',
        '-const x = 1;',
        '+const x = 2;',
        `+const key = '${token}';`,
      ].join('\n'),
    );
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: 'src/app.ts', kind: 'GitHub token' },
    ]);
  });

  it('reads a new file, and names each file of each commit once per kind', () => {
    const log = [
      patch(C2, newFile('notes/aws.txt', `a ${token}`, `b ${token}`)),
      patch(C1, newFile('clean.txt', 'hello'), newFile('more.txt', `c ${token}`)),
    ].join('\n');
    assert.deepEqual(scanPatches(log, none), [
      { commit: C2, place: 'notes/aws.txt', kind: 'GitHub token' },
      { commit: C1, place: 'more.txt', kind: 'GitHub token' },
    ]);
  });

  it('never reads the removed lines: the base has them already', () => {
    const log = patch(
      C1,
      [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +0,0 @@',
        `-${token}`,
      ].join('\n'),
    );
    assert.deepEqual(scanPatches(log, none), []);
  });

  it('counts the lines of each hunk: an added line that looks like a header is still read', () => {
    const log = patch(
      C1,
      newFile('a.txt', '++ b/other.txt', `${token}`, 'diff --git a/x b/x'),
      newFile('b.txt', 'clean'),
    );
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: 'a.txt', kind: 'GitHub token' },
    ]);
  });

  it('refuses a binary file, which the scan cannot read', () => {
    const log = patch(
      C1,
      [
        'diff --git a/img/logo.png b/img/logo.png',
        'new file mode 100644',
        'index 0000000..88768ef',
        'Binary files /dev/null and b/img/logo.png differ',
      ].join('\n'),
    );
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: 'img/logo.png', kind: 'binary file' },
    ]);
  });

  it('names a file whose path holds the secret without its path', () => {
    const path = `keys/${token}.txt`;
    const log = patch(C1, newFile(path, 'hello'));
    const found = scanPatches(log, none);
    assert.deepEqual(found, [
      { commit: C1, place: 'a file whose path looks like a secret', kind: 'GitHub token' },
    ]);
  });

  // Review of #237: diff.interHunkContext puts context lines in a hunk, which its header counts
  // on both sides; counted twice, they would swallow the next file's header and hunk.
  it('counts context lines once: the next file of the commit is still read', () => {
    const log = patch(
      C1,
      [
        'diff --git a/a.txt b/a.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,8 +1,8 @@',
        '-one',
        '+One',
        ...['2', '3', '4', '5', '6', '7'].map((line) => ` ${line}`),
        '-eight',
        '+Eight',
      ].join('\n'),
      newFile('b.txt', token),
    );
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: 'b.txt', kind: 'GitHub token' },
    ]);
  });

  it("leaves integrity hashes out only in a package lock: elsewhere they may be a key's disguise", () => {
    const disguised = `sha512-${'Ab1+'.repeat(21)}Q==`;
    const log = patch(C1, newFile('config.env', `AWS_KEY=${disguised}`));
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: 'config.env', kind: 'long base64 string' },
    ]);
  });

  it('reads the last line of a file that ends without a newline', () => {
    const log = patch(
      C1,
      [
        'diff --git a/a.txt b/a.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +1 @@',
        '-old',
        '\\ No newline at end of file',
        `+${token}`,
        '\\ No newline at end of file',
      ].join('\n'),
    );
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: 'a.txt', kind: 'GitHub token' },
    ]);
  });

  it('reads a path with spaces, which git does not quote', () => {
    const log = patch(C1, newFile('my notes.txt', token));
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: 'my notes.txt', kind: 'GitHub token' },
    ]);
  });

  // Captured from git 2.56 for a file named café.txt: git quotes a path with non-ASCII bytes.
  it('reads a quoted path as git shows it', () => {
    const log = patch(
      C1,
      [
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        'new file mode 100644',
        'index 0000000..7f6c193',
        '--- /dev/null',
        '+++ "b/caf\\303\\251.txt"',
        '@@ -0,0 +1 @@',
        `+${token}`,
      ].join('\n'),
    );
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: '"caf\\303\\251.txt"', kind: 'GitHub token' },
    ]);
  });

  it("leaves out a package lock's integrity hashes, which look random", () => {
    const sri = `sha512-${'Ab1+'.repeat(21)}Q==`;
    const log = patch(C1, newFile('package-lock.json', `      "integrity": "${sri}",`));
    assert.deepEqual(scanPatches(log, none), []);
  });

  it('finds nothing in a clean patch', () => {
    assert.deepEqual(scanPatches(patch(C1, newFile('a.txt', 'hello', 'world')), none), []);
  });
});

describe('commitCandidates', () => {
  it('lists each 40-character hexadecimal word once', () => {
    const a = 'a'.repeat(40);
    const text = `${a} and ${a}, not ${'b'.repeat(39)} nor ${'c'.repeat(41)}; ${C1}`;
    assert.deepEqual(commitCandidates(text), [a, C1]);
  });
});
