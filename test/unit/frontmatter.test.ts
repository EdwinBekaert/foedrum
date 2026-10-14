import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Frontmatter, parseFrontmatter } from '../../src/schemas/frontmatter.ts';

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
});
