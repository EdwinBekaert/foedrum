// The personal denylist's core on plain text and captured git output (ADR 0114, ADR 0021). The
// words are fixtures; no test reads the real list.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deniedLines,
  deniedRefusal,
  parseDenylist,
  scanMessages,
  scanPatches,
  wordsOf,
} from '../../scripts/denylist/core.ts';

const list = ['examplecorp', 'acmewidget'];
const sha = (char: string): string => char.repeat(40);

describe('parseDenylist', () => {
  it('keeps the letters and digits of each entry, lowercased, and skips comments and blanks', () => {
    const text = `${String.fromCharCode(0xfeff)}# clients\n\nExample-Corp\r\n  acme widget \n---\n# Acme\nfoo2\n`;
    assert.deepEqual(parseDenylist(text), ['examplecorp', 'acmewidget', 'foo2']);
  });

  it('reads an empty file as no entries', () => {
    assert.deepEqual(parseDenylist(''), []);
  });
});

describe('wordsOf', () => {
  const cases: [string, string[]][] = [
    ['fooBar', ['foo', 'bar']],
    ['HTTPServer', ['http', 'server']],
    ['snake_case-kebab.dotted', ['snake', 'case', 'kebab', 'dotted']],
    ['v2Api', ['v', '2', 'api']],
    ['  Two words!  ', ['two', 'words']],
    [String.fromCodePoint(0xff25, 0xff58), ['ex']],
    ['', []],
  ];
  for (const [line, words] of cases) {
    it(`splits ${JSON.stringify(line)}`, () => {
      assert.deepEqual(wordsOf(line), words);
    });
  }
});

describe('deniedLines', () => {
  const matching = [
    'examplecorp',
    'We ship to ExampleCorp next week.',
    'const example_corp = 1;',
    'example-corp.config.json',
    'exampleCorpClient',
    'EXAMPLECORP2',
    'Example Corp',
    'acme.widget',
    `${String.fromCodePoint(0xff25)}xamplecorp`,
  ];
  for (const line of matching) {
    it(`finds an entry in ${JSON.stringify(line)}`, () => {
      assert.deepEqual(deniedLines(line, list), [1]);
    });
  }

  const passing = [
    'examplecorporate',
    'notexamplecorp',
    'an example corporate plan',
    'acme widgets',
    'nothing here',
  ];
  for (const line of passing) {
    it(`finds no entry in ${JSON.stringify(line)}`, () => {
      assert.deepEqual(deniedLines(line, list), []);
    });
  }

  it('numbers the lines from 1, with LF or CRLF', () => {
    assert.deepEqual(deniedLines('a\nb examplecorp\nc\r\nExampleCorp\r\n', list), [2, 4]);
  });

  // The words split at a digit, so the last one may be a single character long.
  it('finds an entry whose last word is one character, joined up to its full length', () => {
    assert.deepEqual(deniedLines('the foo2 build\nthe Foo2Bar build', ['foo2']), [1, 2]);
  });

  it('finds nothing with an empty list', () => {
    assert.deepEqual(deniedLines('examplecorp', []), []);
  });
});

describe('scanMessages', () => {
  const entry = (commit: string, people: string[], message: string): string =>
    `\0${commit}\n${people.join('\n')}\n${message}\n`;
  const clean = ['Ada', 'ada@example.com', 'Ada', 'ada@example.com'];

  it('names the message line, the author and the committer, never the word', () => {
    const log = [
      entry(sha('a'), clean, 'Add the plan\n\nFor ExampleCorp, see below.'),
      entry(sha('b'), ['Ada', 'ada@examplecorp.com', 'Bob', 'bob@example.com'], 'Tidy'),
      entry(sha('c'), ['Ada', 'ada@example.com', 'Acme Widget bot', 'bot@x.org'], 'Tidy'),
      entry(sha('d'), clean, 'Nothing to see'),
    ].join('');
    assert.deepEqual(scanMessages(log, list), [
      'commit aaaaaaa message line 3',
      'commit bbbbbbb author',
      'commit ccccccc committer',
    ]);
  });

  it('finds nothing in an empty log', () => {
    assert.deepEqual(scanMessages('', list), []);
  });
});

describe('scanPatches', () => {
  it('reads the added lines of each file with their line numbers, not the removed ones', () => {
    const log = [
      `\0${sha('a')}`,
      '',
      'diff --git a/notes/plan.md b/notes/plan.md',
      'index 1111111..2222222 100644',
      '--- a/notes/plan.md',
      '+++ b/notes/plan.md',
      '@@ -3,0 +4,2 @@',
      '+first line',
      '+we ship to ExampleCorp',
      '@@ -10 +12 @@',
      '-the old examplecorp line',
      '+a new line',
      '@@ -20,2 +22,0 @@',
      '-removed examplecorp',
      '-+examplecorp that looks added',
      'diff --git a/src/a.ts b/src/a.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/src/a.ts',
      '@@ -0,0 +1,3 @@',
      '+const ok = 1;',
      '+@@ -1 +1 @@',
      '+const acmeWidget = 2;',
      '',
    ].join('\n');
    assert.deepEqual(scanPatches(log, list), [
      'commit aaaaaaa notes/plan.md:5',
      'commit aaaaaaa src/a.ts:3',
    ]);
  });

  it('reads a merge as a combined diff: only the lines in its result', () => {
    const log = [
      `\0${sha('b')}`,
      '',
      'diff --cc src/merged.ts',
      'index 1111111,2222222..3333333',
      '--- a/src/merged.ts',
      '+++ b/src/merged.ts',
      '@@@ -1,1 -1,1 +1,2 @@@',
      '- left examplecorp',
      ' -right examplecorp',
      '++const exampleCorpClient = 1;',
      '++ok',
      '',
    ].join('\n');
    assert.deepEqual(scanPatches(log, list), ['commit bbbbbbb src/merged.ts:1']);
  });

  // A line with + in one column only is in the other parent: that parent's commits brought it,
  // and they are read on their own or are on the remote already (ADR 0114).
  it('reads only the lines a merge adds of its own, not those one parent brought', () => {
    const log = [
      `\0${sha('e')}`,
      '',
      'diff --cc src/m.ts',
      '@@@ -1,1 -1,1 +1,3 @@@',
      ' +from main, examplecorp',
      '+ from side, acme widget',
      '++its own, examplecorp',
      '',
    ].join('\n');
    assert.deepEqual(scanPatches(log, list), ['commit eeeeeee src/m.ts:3']);
  });

  it('never names a path that holds a word, and skips the path of a deleted file', () => {
    const log = [
      `\0${sha('c')}`,
      '',
      'diff --git a/docs/ExampleCorp.md b/docs/ExampleCorp.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/docs/ExampleCorp.md',
      '@@ -0,0 +1,2 @@',
      '+fine',
      '+examplecorp',
      'diff --git a/old/acme-widget.txt b/old/acme-widget.txt',
      'deleted file mode 100644',
      '--- a/old/acme-widget.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-acme widget',
      'diff --git "a/sp ace/\\"q\\".md" "b/sp ace/\\"q\\".md"',
      '@@ -1,0 +2 @@',
      '+examplecorp',
      '',
    ].join('\n');
    assert.deepEqual(scanPatches(log, list), [
      'commit ccccccc a file whose path holds a denied word',
      'commit ccccccc a file whose path holds a denied word, line 2',
      'commit ccccccc "sp ace/\\"q\\".md":2',
    ]);
  });

  it('reads nothing of a deleted file, not even its path', () => {
    const log = [
      `\0${sha('c')}`,
      '',
      'diff --git a/old/acme-widget.txt b/old/acme-widget.txt',
      'deleted file mode 100644',
      '--- a/old/acme-widget.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-acme widget',
      '',
    ].join('\n');
    assert.deepEqual(scanPatches(log, list), []);
  });

  // git marks a last line without a newline after it, on each side; the marker is no line.
  it('reads the lines around a "No newline at end of file" marker', () => {
    const log = [
      `\0${sha('d')}`,
      '',
      'diff --git a/end.txt b/end.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+we ship to ExampleCorp',
      '\\ No newline at end of file',
      'diff --git a/next.txt b/next.txt',
      '@@ -0,0 +1 @@',
      '+acme widget',
      '',
    ].join('\n');
    assert.deepEqual(scanPatches(log, list), [
      'commit ddddddd end.txt:1',
      'commit ddddddd next.txt:1',
    ]);
  });

  it('finds nothing in an empty log', () => {
    assert.deepEqual(scanPatches('', list), []);
  });
});

describe('deniedRefusal', () => {
  it('names the first ten places and counts the rest', () => {
    const places = Array.from({ length: 12 }, (_, i) => `commit aaaaaaa f.txt:${i + 1}`);
    const refusal = deniedRefusal('git push', places);
    assert.match(refusal, /^git push is blocked: .*denylist \(ADR 0114\)/);
    assert.match(refusal, /f\.txt:10; and 2 more/);
    assert.doesNotMatch(refusal, /f\.txt:11/);
  });

  it('lists every place when there are ten or fewer', () => {
    const refusal = deniedRefusal('git push', ['commit aaaaaaa author', 'commit aaaaaaa a.md:1']);
    assert.match(refusal, /commit aaaaaaa author; commit aaaaaaa a\.md:1\./);
    assert.doesNotMatch(refusal, /more/);
  });
});
