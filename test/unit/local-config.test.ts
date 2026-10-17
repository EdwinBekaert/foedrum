// .foedrum/local.jsonc: what one machine says about a Brewery (ADR 0063).

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { LocalConfig } from '../../src/schemas/local-config.ts';
import { readJsonc } from '../../src/schemas/read.ts';

const workRoot = resolve('work-root');
const clone = resolve('src', 'web');

describe('LocalConfig', () => {
  it('reads the work root and the clones, with comments', () => {
    const text = `// This machine's paths.\n${JSON.stringify({ workRoot, clones: { 'acme/web': clone } })}`;
    assert.deepEqual(readJsonc(text, LocalConfig), {
      valid: true,
      value: { workRoot, clones: { 'acme/web': clone } },
    });
  });

  it('has no clones and the default work root when it says nothing', () => {
    assert.deepEqual(LocalConfig.safeParse({}).data, { clones: {} });
  });

  it('refuses a relative work root or clone, which would depend on the folder serve runs in', () => {
    assert.equal(LocalConfig.safeParse({ workRoot: 'work' }).success, false);
    assert.equal(LocalConfig.safeParse({ clones: { 'acme/web': '../web' } }).success, false);
  });

  it('refuses a clone of a repository that is not owner/name, and unknown fields', () => {
    assert.equal(LocalConfig.safeParse({ clones: { web: clone } }).success, false);
    assert.equal(LocalConfig.safeParse({ workroot: workRoot }).success, false);
  });
});
