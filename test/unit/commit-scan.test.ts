// The secret scan of a batch's commits (ADR 0079), the pure core: findings in the messages and the
// added lines of git's output, each naming the commit, the place and the kind, never the text.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  commitCandidates,
  MESSAGE,
  scanHeaders,
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

/** `git log --format=raw` output of one commit: its headers, then its message indented. */
const raw = (commit: string, headers: string[], message = 'Plan'): string =>
  [
    `commit ${commit}`,
    `tree ${'3'.repeat(40)}`,
    `parent ${'4'.repeat(40)}`,
    ...headers,
    '',
    ...message.split('\n').map((line) => `    ${line}`),
    '',
  ].join('\n');
const person = (name: string, email = 'brewer@example.com') =>
  `${name} <${email}> 1792484716 +0200`;

describe('scanHeaders (review of #237)', () => {
  it('names the author or the committer that holds a secret, never the text', () => {
    const log = [
      raw(C2, [`author ${person(token)}`, `committer ${person('Brewer')}`]),
      raw(C1, [`author ${person('Brewer')}`, `committer ${person('Brewer', `${token}@x.y`)}`]),
    ].join('\n');
    const found = scanHeaders(log, none);
    assert.deepEqual(found, [
      { commit: C2, place: 'author', kind: 'GitHub token' },
      { commit: C1, place: 'committer', kind: 'GitHub token' },
    ]);
    assert.doesNotMatch(JSON.stringify(found), /A1b2/);
  });

  it('reads every other header the push carries: a signature, an encoding', () => {
    const log = raw(C1, [
      `author ${person('Brewer')}`,
      `committer ${person('Brewer')}`,
      `encoding ${token}`,
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ` ${token}`,
      ' -----END PGP SIGNATURE-----',
    ]);
    assert.deepEqual(scanHeaders(log, none), [
      { commit: C1, place: 'header encoding', kind: 'GitHub token' },
      { commit: C1, place: 'header gpgsig', kind: 'GitHub token' },
    ]);
  });

  it("does not take a real signature's armour for a key", () => {
    const armour = 'iQIzBAABCAAdFiEE1a2B3c4D5e6F7g8H9i0J1k2L3m4FAmcUAbcACgkQ1a2B3c4D5e6F'.slice(
      0,
      64,
    );
    const log = raw(C1, [
      `author ${person('Brewer')}`,
      `committer ${person('Brewer')}`,
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ` ${armour}`,
      ` ${armour}`,
      ' =Ab1c',
      ' -----END PGP SIGNATURE-----',
    ]);
    assert.deepEqual(scanHeaders(log, none), []);
  });

  // The control for the test above: the same armour anywhere but in a signature is read as a key.
  it("spares only a signature's armour: a SHA-256 one too, but not a merged tag's", () => {
    const armour = 'iQIzBAABCAAdFiEE1a2B3c4D5e6F7g8H9i0J1k2L3m4FAmcUAbcACgkQ1a2B3c4D5e6F'.slice(
      0,
      64,
    );
    const signed = (name: string) =>
      raw(C1, [
        `author ${person('Brewer')}`,
        `${name} -----BEGIN PGP SIGNATURE-----`,
        ` ${armour}`,
        ' -----END PGP SIGNATURE-----',
      ]);
    assert.deepEqual(scanHeaders(signed('gpgsig-sha256'), none), []);
    assert.deepEqual(scanHeaders(signed('mergetag'), none), [
      { commit: C1, place: 'header mergetag', kind: 'long base64 string' },
    ]);
  });

  // git ends the headers only at an empty line; a line that is only a CR is still a header.
  it('reads on past a header line that is only a carriage return', () => {
    const log = raw(C1, [`author ${person('Brewer')}`, '\r', `x-leak ${token}`]);
    assert.deepEqual(scanHeaders(log, none), [
      { commit: C1, place: 'header x-leak', kind: 'GitHub token' },
    ]);
  });

  it('leaves the tree, the parents and the message to the other reads', () => {
    const log = raw(C1, [`author ${person('Brewer')}`, `committer ${person('Brewer')}`], token);
    assert.deepEqual(scanHeaders(log, none), []);
  });

  it('names a header whose plain-word name looks like a secret without its name', () => {
    const name = `deadbeef${'0123456789abcdef'.repeat(2)}`;
    const log = raw(C1, [`author ${person('Brewer')}`, `${name} x`]);
    const found = scanHeaders(log, none);
    assert.deepEqual(found, [{ commit: C1, place: 'a header', kind: 'long hexadecimal string' }]);
    assert.doesNotMatch(JSON.stringify(found), /deadbeef/);
  });

  it('names a header whose name is no plain word without its name', () => {
    const log = raw(C1, [`author ${person('Brewer')}`, `${token} ${token}`]);
    assert.deepEqual(scanHeaders(log, none), [
      { commit: C1, place: 'a header', kind: 'GitHub token' },
    ]);
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

  it('lets a binary file go that a commit only deletes: the base has it', () => {
    const log = patch(
      C1,
      [
        'diff --git a/docs/old.png b/docs/old.png',
        'deleted file mode 100644',
        'index 88768ef..0000000',
        'Binary files a/docs/old.png and /dev/null differ',
      ].join('\n'),
    );
    assert.deepEqual(scanPatches(log, none), []);
  });

  it('refuses a new binary file whose name only looks like a deletion', () => {
    const path = 'x and /dev/null';
    const log = patch(
      C1,
      [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        'index 0000000..88768ef',
        `Binary files /dev/null and b/${path} differ`,
      ].join('\n'),
    );
    assert.deepEqual(scanPatches(log, none), [{ commit: C1, place: path, kind: 'binary file' }]);
  });

  it('names a binary file whose path holds the secret without its path', () => {
    const path = `keys/${token}.bin`;
    const log = patch(
      C1,
      [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        'index 0000000..88768ef',
        `Binary files /dev/null and b/${path} differ`,
      ].join('\n'),
    );
    const found = scanPatches(log, none);
    assert.deepEqual(found, [
      { commit: C1, place: 'a file whose path looks like a secret', kind: 'binary file' },
      { commit: C1, place: 'a file whose path looks like a secret', kind: 'GitHub token' },
    ]);
    assert.doesNotMatch(JSON.stringify(found), /A1b2/);
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

  it('knows a lock by its name, in any folder', () => {
    const sri = `sha512-${'Ab1+'.repeat(21)}Q==`;
    for (const lock of ['packages/app/package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      const log = patch(C1, newFile(lock, `  integrity ${sri}`));
      assert.deepEqual(scanPatches(log, none), [], lock);
    }
    const log = patch(C1, newFile('docs/package-lock.json.md', `  integrity ${sri}`));
    assert.deepEqual(scanPatches(log, none), [
      { commit: C1, place: 'docs/package-lock.json.md', kind: 'long base64 string' },
    ]);
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
