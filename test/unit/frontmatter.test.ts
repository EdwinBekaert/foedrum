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
});
