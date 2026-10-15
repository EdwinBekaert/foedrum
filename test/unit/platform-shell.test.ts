import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { windowsCommandLine } from '../../src/platform/shell.ts';

describe('windowsCommandLine', () => {
  it('joins the file and plain arguments with spaces', () => {
    assert.equal(
      windowsCommandLine('claude.cmd', ['-p', '--output-format=stream-json', '--model', 'opus']),
      'claude.cmd -p --output-format=stream-json --model opus',
    );
  });

  it('quotes a file or argument with a space in it, and an empty argument', () => {
    assert.equal(
      windowsCommandLine('C:\\Program Files\\nodejs\\claude.cmd', [
        '--settings',
        'C:\\Users\\Ann Lee\\settings.json',
        '',
      ]),
      '"C:\\Program Files\\nodejs\\claude.cmd" --settings "C:\\Users\\Ann Lee\\settings.json" ""',
    );
  });

  // Before a closing quote, a backslash would escape it for the program's argument parser.
  it('doubles the backslashes at the end of a quoted argument', () => {
    assert.equal(
      windowsCommandLine('claude.cmd', ['--add-dir', 'C:\\Work Trees\\12\\']),
      'claude.cmd --add-dir "C:\\Work Trees\\12\\\\"',
    );
  });

  it('accepts letters and digits beyond ASCII', () => {
    assert.equal(
      windowsCommandLine('claude.cmd', ['C:\\Users\\José\\näme_1']),
      'claude.cmd C:\\Users\\José\\näme_1',
    );
  });

  // Each of these means something to cmd.exe, also inside quotes (" % !), or ends the line.
  for (const bad of [
    '"',
    '%',
    '!',
    '^',
    '&',
    '|',
    '<',
    '>',
    '(',
    ')',
    '\n',
    '\r',
    '\t',
    '`',
    '$',
    ';',
    '*',
    '?',
    "'",
  ]) {
    it(`rejects ${JSON.stringify(bad)} in an argument, naming the argument`, () => {
      assert.throws(
        () => windowsCommandLine('claude.cmd', ['-p', `a${bad}b`]),
        /argument 2 .*cannot go through the Windows shell/,
      );
    });
  }

  it('rejects the file the same way', () => {
    assert.throws(
      () => windowsCommandLine('claude.cmd&calc', []),
      /claude\.cmd&calc.*cannot go through the Windows shell/,
    );
  });

  it('rejects an empty file', () => {
    assert.throws(() => windowsCommandLine('', ['-p']), /cannot go through the Windows shell/);
  });
});
