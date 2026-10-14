import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Frontmatter, parseFrontmatter } from '../../src/schemas/frontmatter.ts';
import { ParseError } from '../../src/schemas/jsonc.ts';

interface Case {
  name: string;
  text: string;
  expected: Frontmatter;
}

const check = (cases: Case[]): void => {
  for (const { name, text, expected } of cases) {
    it(name, () => {
      assert.deepEqual(parseFrontmatter(text), expected);
    });
  }
};

describe('parseFrontmatter', () => {
  describe('frontmatter and body', () => {
    check([
      {
        name: 'single-line object',
        text: '---\n{"name": "taster"}\n---\n# Prompt\n',
        expected: { data: { name: 'taster' }, body: '# Prompt\n' },
      },
      {
        name: 'multi-line object',
        text: '---\n{\n  "name": "taster",\n  "tools": ["Read"]\n}\n---\nBody\n',
        expected: { data: { name: 'taster', tools: ['Read'] }, body: 'Body\n' },
      },
      {
        name: '--- inside the body',
        text: '---\n{}\n---\nabove\n---\nbelow\n',
        expected: { data: {}, body: 'above\n---\nbelow\n' },
      },
      {
        name: '--- inside a string value',
        text: '---\n{"rule": "---"}\n---\nBody',
        expected: { data: { rule: '---' }, body: 'Body' },
      },
    ]);
  });

  describe('empty or missing body', () => {
    check([
      { name: 'empty body', text: '---\n{"a": 1}\n---\n', expected: { data: { a: 1 }, body: '' } },
      {
        name: 'no line break after ---',
        text: '---\n{"a": 1}\n---',
        expected: { data: { a: 1 }, body: '' },
      },
      { name: 'CRLF, empty body', text: '---\r\n{}\r\n---\r\n', expected: { data: {}, body: '' } },
      {
        name: 'CRLF, no line break after ---',
        text: '---\r\n{}\r\n---',
        expected: { data: {}, body: '' },
      },
      {
        name: 'blank lines only',
        text: '---\n{}\n---\n\n\n',
        expected: { data: {}, body: '\n\n' },
      },
    ]);
  });

  describe('line endings and byte order mark', () => {
    check([
      {
        name: 'CRLF',
        text: '---\r\n{\r\n  "name": "taster"\r\n}\r\n---\r\nBody\r\nmore\r\n',
        expected: { data: { name: 'taster' }, body: 'Body\r\nmore\r\n' },
      },
      {
        name: 'BOM',
        text: '\uFEFF---\n{"name": "taster"}\n---\nBody\n',
        expected: { data: { name: 'taster' }, body: 'Body\n' },
      },
      {
        name: 'BOM and CRLF',
        text: '\uFEFF---\r\n{}\r\n---\r\nBody',
        expected: { data: {}, body: 'Body' },
      },
    ]);
  });

  describe('malformed input', () => {
    const cases: { name: string; text: string; line: number; column: number; reason?: RegExp }[] = [
      { name: 'empty file', text: '', line: 1, column: 1, reason: /'---'/ },
      { name: 'no frontmatter', text: '# Title\n', line: 1, column: 1, reason: /'---'/ },
      { name: 'text after the opening ---', text: '--- x\n{}\n---\n', line: 1, column: 1 },
      {
        name: 'no closing ---',
        text: '---\n{"a": 1}\nBody\n',
        line: 1,
        column: 1,
        reason: /closing/,
      },
      { name: 'nothing between the --- lines', text: '---\n---\nBody', line: 2, column: 1 },
      { name: 'array', text: '---\n[1]\n---\n', line: 2, column: 1, reason: /object/ },
      { name: 'null', text: '---\n\n  null\n---\n', line: 3, column: 3, reason: /object/ },
      { name: 'malformed JSON', text: '---\n{\n  "a" 1\n}\n---\n', line: 3, column: 7 },
      { name: 'BOM and CRLF', text: '\uFEFF---\r\n{"a": }\r\n---\r\n', line: 2, column: 7 },
    ];

    for (const { name, text, line, column, reason } of cases) {
      it(name, () => {
        assert.throws(
          () => parseFrontmatter(text),
          (error: unknown) => {
            assert.ok(error instanceof ParseError, `expected a ParseError, got ${String(error)}`);
            assert.deepEqual({ line: error.line, column: error.column }, { line, column });
            if (reason) assert.match(error.message, reason);
            return true;
          },
        );
      });
    }
  });
});
