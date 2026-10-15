import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readDoc, readJsonc } from '../../src/schemas/read.ts';
import { z } from '../../src/schemas/zod.ts';

const Settings = z.strictObject({ name: z.string(), size: z.int().default(1) });

describe('readJsonc', () => {
  it('reads JSONC with comments and trailing commas and applies the schema', () => {
    const text = '﻿{\r\n  // the name\r\n  "name": "pint",\r\n}\r\n';
    assert.deepEqual(readJsonc(text, Settings), { valid: true, value: { name: 'pint', size: 1 } });
  });

  it('gives the position of a syntax error', () => {
    const result = readJsonc('{\n  "name": "pint"\n  "size": 2\n}', Settings);
    assert.equal(result.valid, false);
    assert.match(result.valid ? '' : result.reason, /line 3, column 3/);
  });

  it('names the field that breaks the schema', () => {
    const result = readJsonc('{ "name": "pint", "colour": "amber" }', Settings);
    assert.equal(result.valid, false);
    assert.match(result.valid ? '' : result.reason, /colour/);
  });

  it('rejects input nested deeper than the reader allows', () => {
    const result = readJsonc(`${'['.repeat(100)}${']'.repeat(100)}`, z.unknown());
    assert.equal(result.valid, false);
  });
});

describe('readDoc', () => {
  it('reads the frontmatter against the schema and returns the body', () => {
    const text = '---\n{ "name": "pint", } // a comment\n---\n# Body\n';
    assert.deepEqual(readDoc(text, Settings), {
      valid: true,
      frontmatter: { name: 'pint', size: 1 },
      body: '# Body\n',
    });
  });

  it('rejects a file without frontmatter', () => {
    const result = readDoc('# Body only\n', Settings);
    assert.equal(result.valid, false);
    assert.match(result.valid ? '' : result.reason, /line 1, column 1/);
  });

  it('names the field that breaks the schema', () => {
    const result = readDoc('---\n{ "name": 7 }\n---\n', Settings);
    assert.equal(result.valid, false);
    assert.match(result.valid ? '' : result.reason, /name/);
  });
});
