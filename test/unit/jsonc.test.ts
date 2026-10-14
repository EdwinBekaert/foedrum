import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJsonc } from '../../src/schemas/jsonc.ts';

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
});
