import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maxInputLength, ParseError, parseJsonc } from '../../src/formats/jsonc.ts';

interface Case {
  name: string;
  text: string;
  expected: unknown;
}

const check = (cases: Case[]): void => {
  for (const { name, text, expected } of cases) {
    it(name, () => {
      assert.deepEqual(parseJsonc(text), expected);
    });
  }
};

describe('parseJsonc', () => {
  describe('plain JSON', () => {
    check([
      {
        name: 'object',
        text: '{"a": 1, "b": [true, null, "x"]}',
        expected: { a: 1, b: [true, null, 'x'] },
      },
      { name: 'array', text: '[1, 2.5, -3e2]', expected: [1, 2.5, -300] },
      { name: 'scalar', text: ' "text" ', expected: 'text' },
      { name: 'nested', text: '{"a": {"b": {"c": []}}}', expected: { a: { b: { c: [] } } } },
    ]);
  });

  describe('comments', () => {
    check([
      { name: 'line comment', text: '{\n  // note\n  "a": 1 // trailing\n}', expected: { a: 1 } },
      { name: 'line comment at end of input', text: '[1] // done', expected: [1] },
      { name: 'block comment', text: '{/* note */"a": /* inline */ 1}', expected: { a: 1 } },
      {
        name: 'multi-line block comment',
        text: '/*\n * header\n */\n{"a": 1}',
        expected: { a: 1 },
      },
      { name: 'block comment containing //', text: '[/* a // b */ 1]', expected: [1] },
      { name: 'line comment containing /*', text: '[1 // a /* b\n]', expected: [1] },
      { name: 'comment between tokens', text: '{"a"/**/:/**/1}', expected: { a: 1 } },
    ]);
  });

  describe('strings', () => {
    check([
      {
        name: '// inside a string',
        text: '{"url": "https://example.com"}',
        expected: { url: 'https://example.com' },
      },
      {
        name: '/* */ inside a string',
        text: '["/* not a comment */"]',
        expected: ['/* not a comment */'],
      },
      { name: 'comment marker in a key', text: '{"a//b": 1}', expected: { 'a//b': 1 } },
      {
        name: 'escaped quote before //',
        text: '["say \\"hi\\" // still a string"]',
        expected: ['say "hi" // still a string'],
      },
      {
        name: 'escaped backslash ending a string',
        text: '["c:\\\\" // comment\n]',
        expected: ['c:\\'],
      },
      { name: 'unicode escape', text: '["\\u002f\\u002f"]', expected: ['//'] },
      { name: 'comment after a string', text: '{"a": "x" /* note */}', expected: { a: 'x' } },
    ]);
  });

  describe('trailing commas', () => {
    check([
      { name: 'in an object', text: '{"a": 1,}', expected: { a: 1 } },
      { name: 'in an array', text: '[1, 2,]', expected: [1, 2] },
      { name: 'before whitespace and newlines', text: '[\n  1,\n  2,\n]', expected: [1, 2] },
      { name: 'before a comment', text: '{"a": 1, // last\n}', expected: { a: 1 } },
      { name: 'before a block comment', text: '[1, /* end */ ]', expected: [1] },
      { name: 'nested', text: '{"a": [1, {"b": [2,],},],}', expected: { a: [1, { b: [2] }] } },
      { name: 'inside a string', text: '["1,]", "2,}",]', expected: ['1,]', '2,}'] },
    ]);
  });

  describe('line endings and byte order mark', () => {
    check([
      { name: 'BOM', text: '\uFEFF{"a": 1}', expected: { a: 1 } },
      {
        name: 'CRLF with comments and trailing commas',
        text: '{\r\n  // note\r\n  "a": [1,\r\n  ], /* x\r\n */\r\n}\r\n',
        expected: { a: [1] },
      },
      { name: 'BOM and CRLF', text: '\uFEFF// header\r\n[1,]\r\n', expected: [1] },
    ]);
  });

  describe('nesting up to 64 levels', () => {
    const nested = (depth: number): unknown => (depth === 0 ? 1 : [nested(depth - 1)]);
    check([
      { name: '64 arrays', text: `${'['.repeat(64)}1${']'.repeat(64)}`, expected: nested(64) },
      {
        name: 'brackets in strings and comments do not count',
        text: `[/* ${'{'.repeat(100)} */ "${'['.repeat(100)}"]`,
        expected: ['['.repeat(100)],
      },
    ]);
  });

  describe('input size', () => {
    check([
      {
        name: `exactly ${maxInputLength} characters`,
        text: `"${'a'.repeat(maxInputLength - 2)}"`,
        expected: 'a'.repeat(maxInputLength - 2),
      },
    ]);
  });

  describe('malformed input', () => {
    const cases: { name: string; text: string; line: number; column: number; reason?: RegExp }[] = [
      { name: 'empty input', text: '', line: 1, column: 1, reason: /end of input/ },
      { name: 'only a comment', text: '// nothing', line: 1, column: 11, reason: /end of input/ },
      { name: 'missing colon', text: '{\n  "a" 1\n}', line: 2, column: 7, reason: /':'/ },
      { name: 'missing value', text: '{\n  "a": }', line: 2, column: 8 },
      { name: 'invalid literal', text: '[tru]', line: 1, column: 2 },
      { name: 'missing comma', text: '[1 2]', line: 1, column: 4 },
      { name: 'unclosed array', text: '[1, 2', line: 1, column: 6, reason: /end of input/ },
      { name: 'unclosed string', text: '{"a": "x\n}', line: 1, column: 9 },
      { name: 'invalid escape', text: '["\\x"]', line: 1, column: 3 },
      { name: 'single-quoted string', text: "['a']", line: 1, column: 2 },
      { name: 'content after the value', text: '{"a": 1}\n// ok\nx', line: 3, column: 1 },
      { name: 'lone comma in an array', text: '[,]', line: 1, column: 2 },
      { name: 'lone comma in an object', text: '{,}', line: 1, column: 2 },
      { name: 'double comma', text: '[1,,]', line: 1, column: 4 },
      {
        name: 'unclosed block comment',
        text: '[1 /* never\nclosed',
        line: 1,
        column: 4,
        reason: /comment/,
      },
      { name: 'after a comment on the same line', text: '/* c */ {"a" 1}', line: 1, column: 14 },
      { name: 'CRLF', text: '{\r\n  "a": tru\r\n}', line: 2, column: 8 },
      { name: 'BOM is not a column', text: '\uFEFF[1 2]', line: 1, column: 4 },
      {
        name: '65 nested arrays',
        text: `${'['.repeat(65)}1${']'.repeat(65)}`,
        line: 1,
        column: 65,
        reason: /nest/,
      },
      {
        name: '65 nested objects',
        text: `${'{"a":'.repeat(65)}1${'}'.repeat(65)}`,
        line: 1,
        column: 321,
        reason: /nest/,
      },
      {
        name: '65 levels over 65 lines',
        text: '[\n'.repeat(65),
        line: 65,
        column: 1,
        reason: /nest/,
      },
      {
        name: 'one character too large',
        text: `"${'a'.repeat(maxInputLength - 1)}"`,
        line: 1,
        column: maxInputLength + 1,
        reason: /large/,
      },
      {
        name: 'too large over many lines',
        text: `${' \n'.repeat(maxInputLength / 2)}1`,
        line: maxInputLength / 2 + 1,
        column: 1,
        reason: /large/,
      },
      {
        name: 'deep unclosed nesting',
        text: '['.repeat(100_000),
        line: 1,
        column: 65,
        reason: /nest/,
      },
    ];

    for (const { name, text, line, column, reason } of cases) {
      it(name, () => {
        assert.throws(
          () => parseJsonc(text),
          (error: unknown) => {
            assert.ok(error instanceof ParseError, `expected a ParseError, got ${String(error)}`);
            assert.deepEqual({ line: error.line, column: error.column }, { line, column });
            assert.match(error.message, new RegExp(`at line ${line}, column ${column}$`));
            if (reason) assert.match(error.message, reason);
            return true;
          },
        );
      });
    }
  });
});
