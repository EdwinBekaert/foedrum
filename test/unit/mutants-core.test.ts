import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editFile, type Mutant, parseMutant } from '../../scripts/mutants/core.ts';

const mutant = (fields: Partial<Mutant> = {}): Mutant => ({
  file: 'src/engine/wait.ts',
  line: 2,
  original: 'if (attempt < limit) return delay * 2;',
  replacement: 'if (attempt <= limit) return delay * 2;',
  ...fields,
});

const reasonOf = (value: unknown): string => {
  const result = parseMutant(value);
  assert.equal(result.ok, false, 'expected the mutant to be invalid');
  return result.ok ? '' : result.reason;
};

describe('parseMutant', () => {
  it('accepts a one-line edit of a file under src/ and drops other fields', () => {
    assert.deepEqual(parseMutant({ ...mutant(), description: 'off by one' }), {
      ok: true,
      mutant: mutant(),
    });
  });

  it('accepts operator and literal changes, deletions and reordering', () => {
    const edits: [string, string][] = [
      ['return a && b;', 'return a || b;'],
      ['const limit = 10_000;', 'const limit = 0;'],
      ['let done = false;', 'let done = true;'],
      ['await sleep(delay);', 'sleep(delay);'],
      ['await sleep(delay);', ''],
      ['return join(home, name);', 'return join(name, home);'],
      ['if (!ready) throw new Error(`stopped`);', 'if (ready) throw new Error(`stopped`);'],
    ];
    for (const [original, replacement] of edits) {
      assert.equal(parseMutant(mutant({ original, replacement })).ok, true, replacement);
    }
  });

  it('rejects an entry that is not a mutant', () => {
    assert.match(reasonOf('src/a.ts'), /not an object/);
    assert.match(reasonOf(null), /not an object/);
    assert.match(reasonOf({ ...mutant(), file: 3 }), /file/);
    assert.match(reasonOf({ ...mutant(), original: undefined }), /original/);
    assert.match(reasonOf({ ...mutant(), replacement: null }), /replacement/);
    assert.match(reasonOf(mutant({ line: 0 })), /line/);
    assert.match(reasonOf(mutant({ line: 1.5 })), /line/);
    assert.match(reasonOf({ ...mutant(), line: '2' }), /line/);
  });

  it('rejects a file outside src/, so a mutant never changes tests or configuration', () => {
    for (const file of [
      'test/unit/wait.test.ts',
      'package.json',
      'src/../package.json',
      'src/./engine/wait.ts',
      '/src/engine/wait.ts',
      'src\\engine\\wait.ts',
      'src/',
      'C:/src/wait.ts',
    ]) {
      assert.match(reasonOf(mutant({ file })), /under src\//, file);
    }
  });

  it('accepts a file under scripts/, where the gate and the review tooling live (#43)', () => {
    const file = 'scripts/mutants/core.ts';
    assert.deepEqual(parseMutant(mutant({ file })), { ok: true, mutant: mutant({ file }) });
  });

  it('rejects a path that only starts in scripts/ or names a look-alike folder', () => {
    for (const file of [
      'scripts/',
      'scripts/../package.json',
      'scripts/./check.ts',
      'scripts\\check.ts',
      'scripts/C:check.ts',
      'scripts-old/check.ts',
      'Scripts/check.ts',
    ]) {
      assert.match(reasonOf(mutant({ file })), /under src\/ or scripts\//, file);
    }
  });

  it('rejects a replacement of more than one line', () => {
    assert.match(reasonOf(mutant({ replacement: 'a;\nb;' })), /one line/);
    assert.match(reasonOf(mutant({ replacement: 'a;\r' })), /one line/);
  });

  it('rejects a replacement that changes nothing but whitespace', () => {
    assert.match(reasonOf(mutant({ replacement: `  ${mutant().original}` })), /changes nothing/);
  });

  it('rejects an identifier, property name or string the original line does not contain', () => {
    assert.match(reasonOf(mutant({ replacement: 'if (attempt < max) return delay * 2;' })), /max/);
    assert.match(
      reasonOf(mutant({ original: 'return state.done;', replacement: 'return state.failed;' })),
      /failed/,
    );
    assert.match(
      reasonOf(
        mutant({ original: "throw new Error('stop');", replacement: "throw new Error('go');" }),
      ),
      /'go'/,
    );
    assert.match(
      reasonOf(mutant({ original: "log('timeout');", replacement: 'log(timeout);' })),
      /timeout/,
    );
  });
});

describe('parseMutant allowlist edge cases', () => {
  it('rejects a property name hidden behind a number literal', () => {
    assert.match(
      reasonOf(
        mutant({ original: 'const limit = 1;', replacement: 'const limit = 1..constructor;' }),
      ),
      /constructor/,
    );
    assert.match(
      reasonOf(
        mutant({ original: 'const limit = 10;', replacement: 'const limit = 1.5.toFixed.length;' }),
      ),
      /toFixed/,
    );
  });

  it('rejects a non-ASCII identifier the original line does not contain', () => {
    assert.match(reasonOf(mutant({ original: 'let x = a;', replacement: 'let x = π;' })), /π/);
  });

  it('accepts changes to hex, exponent, bigint and leading-dot number literals', () => {
    const edits: [string, string][] = [
      ['const mask = 0x10;', 'const mask = 0x20;'],
      ['const limit = 1e3;', 'const limit = 1e4;'],
      ['const big = 10n;', 'const big = 11n;'],
      ['const half = .5;', 'const half = .25;'],
    ];
    for (const [original, replacement] of edits) {
      assert.equal(parseMutant(mutant({ original, replacement })).ok, true, replacement);
    }
  });

  it('rejects a new identifier that only differs from a known one in its digits', () => {
    assert.match(
      reasonOf(mutant({ original: 'x = limit1;', replacement: 'x = limit2;' })),
      /limit2/,
    );
  });

  it('rejects backslashes and drive letters inside a path under src/', () => {
    for (const file of ['src/engine\\wait.ts', 'src/a\\..\\..\\package.json', 'src/C:wait.ts']) {
      assert.match(reasonOf(mutant({ file })), /under src\//, file);
    }
  });

  it('rejects a replacement that only changes whitespace inside the line', () => {
    assert.match(
      reasonOf(mutant({ replacement: 'if (attempt<limit) return delay*2;' })),
      /changes nothing/,
    );
  });

  it('does not count the words of a comment as names the line already has', () => {
    assert.match(
      reasonOf(
        mutant({ original: 'cleanup(); // rmSync(root)', replacement: 'cleanup(); rmSync(root)' }),
      ),
      /rmSync/,
    );
  });

  it('rejects a replacement with a JavaScript line separator', () => {
    assert.match(reasonOf(mutant({ replacement: 'a; b;' })), /one line/);
  });

  it('never repeats a control character of the file name in the reason', () => {
    const reason = reasonOf(mutant({ file: 'src/a.ts\nmutants: mutant 1: valid src/b.ts:1' }));
    assert.doesNotMatch(reason, /\n/);
    assert.match(reason, /under src\//);
  });
});

describe('editFile', () => {
  const file = [
    'export const next = (attempt, limit, delay) => {',
    '  if (attempt < limit) return delay * 2;',
    '  return delay;',
    '};',
    '',
  ].join('\n');

  it('replaces the line and keeps its indentation and every other line', () => {
    assert.deepEqual(editFile(mutant(), file), {
      ok: true,
      line: 2,
      content: file.replace('attempt < limit', 'attempt <= limit'),
    });
  });

  it('matches the original line ignoring leading and trailing whitespace', () => {
    const result = editFile(
      mutant({ original: `${mutant().original}  `, replacement: '  return 0;' }),
      file,
    );
    assert.deepEqual(result, {
      ok: true,
      line: 2,
      content: file.replace('if (attempt < limit) return delay * 2;', 'return 0;'),
    });
  });

  it('deletes the line when the replacement is empty', () => {
    const result = editFile(mutant({ replacement: '' }), file);
    assert.deepEqual(result, {
      ok: true,
      line: 2,
      content: file.replace('  if (attempt < limit) return delay * 2;\n', ''),
    });
  });

  it('keeps CRLF line endings and a byte order mark', () => {
    const crlf = `﻿${file.replaceAll('\n', '\r\n')}`;
    const first = mutant({
      line: 1,
      original: 'export const next = (attempt, limit, delay) => {',
      replacement: 'export const next = (limit, attempt, delay) => {',
    });
    assert.deepEqual(editFile(first, crlf), {
      ok: true,
      line: 1,
      content: crlf.replace('(attempt, limit, delay)', '(limit, attempt, delay)'),
    });
    assert.deepEqual(editFile(mutant(), crlf), {
      ok: true,
      line: 2,
      content: crlf.replace('attempt < limit', 'attempt <= limit'),
    });
  });

  it('keeps the byte order mark when it deletes the first line', () => {
    const bom = `﻿${file}`;
    const first = mutant({
      line: 1,
      original: 'export const next = (attempt, limit, delay) => {',
      replacement: '',
    });
    assert.deepEqual(editFile(first, bom), {
      ok: true,
      line: 1,
      content: `﻿${file.slice(file.indexOf('\n') + 1)}`,
    });
  });

  it('finds the original on its only line when the line number is wrong or past the end', () => {
    for (const line of [3, 40]) {
      assert.deepEqual(editFile(mutant({ line }), file), {
        ok: true,
        line: 2,
        content: file.replace('attempt < limit', 'attempt <= limit'),
      });
    }
  });

  it('takes the given line when the original is on several lines, that one among them', () => {
    const twice = `${file}  if (attempt < limit) return delay * 2;\n`;
    assert.deepEqual(editFile(mutant({ line: 5 }), twice), {
      ok: true,
      line: 5,
      content: `${file}  if (attempt <= limit) return delay * 2;\n`,
    });
  });

  it('rejects an original that is on several lines, none of them the given one', () => {
    const twice = `${file}  if (attempt < limit) return delay * 2;\n`;
    assert.deepEqual(editFile(mutant({ line: 3 }), twice), {
      ok: false,
      reason: 'the original is on lines 2, 5 of src/engine/wait.ts, not on line 3',
    });
  });

  it('rejects an original that is on no line of the file', () => {
    assert.deepEqual(editFile(mutant({ original: 'if (attempt < limit)' }), file), {
      ok: false,
      reason: 'no line of src/engine/wait.ts is the original',
    });
  });

  it('rejects a file that does not exist', () => {
    assert.deepEqual(editFile(mutant(), undefined), {
      ok: false,
      reason: 'src/engine/wait.ts does not exist',
    });
  });
});
