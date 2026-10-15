import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BrewerFrontmatter } from '../../src/schemas/brewer.ts';
import { readDoc } from '../../src/schemas/read.ts';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'brewers', 'cellarman.md');

const taster = {
  name: 'taster',
  description: 'Reviews a diff through one lens',
  version: 1,
  model: 'reviewer',
  effort: 'medium',
  output: { doc: 'review.md', schema: 'review' },
  produces: 'report',
  tools: { allow: ['Read', 'Grep', 'Bash(git diff*)'] },
  access: 'read',
  tree: 'task',
  deadline: '20m',
  maxAttempts: 2,
};

const cooper = {
  ...taster,
  name: 'cooper',
  description: 'Fixes review findings',
  output: { doc: 'fix-report.md', schema: 'fixReport' },
  produces: 'commits',
  access: 'write',
  git: { commit: true },
};

const accepted = (value: unknown): boolean => BrewerFrontmatter.safeParse(value).success;

describe('BrewerFrontmatter', () => {
  it('accepts the example brewer of brewers-and-recipes §1.2', () => {
    const result = readDoc(readFileSync(fixture, 'utf8'), BrewerFrontmatter);
    assert.equal(result.valid, true, result.valid ? '' : result.reason);
    assert.match(result.valid ? result.body : '', /^Implement the plan in \{plan\}/);
  });

  it('fills in the defaults of a read-only brewer', () => {
    assert.deepEqual(BrewerFrontmatter.parse(taster), {
      ...taster,
      inputs: [],
      houseYeast: false,
      tools: { allow: taster.tools.allow, deny: [] },
      skills: [],
      mcp: [],
      context: 'lean',
      env: {},
      retryMode: 'fresh',
      guards: [],
    });
  });

  it('defaults a writing brewer to not committing', () => {
    const { git: _, ...noGit } = cooper;
    const parsed = BrewerFrontmatter.parse({ ...noGit, produces: 'report' });
    assert.deepEqual((parsed as { git?: unknown }).git, { commit: false });
  });

  it('accepts every tree for a read-only brewer', () => {
    for (const tree of ['task', 'integration', 'checkout', 'scratch']) {
      assert.equal(accepted({ ...taster, tree }), true, tree);
    }
  });

  it('accepts inputs from the order, a step and a repository file', () => {
    const inputs = [
      { name: 'order', from: 'order' },
      { name: 'plan', from: 'step:plan', trusted: false },
      { name: 'readme', from: 'file:docs/README.md' },
    ];
    assert.equal(accepted({ ...taster, inputs }), true);
  });

  it('defaults an input to untrusted', () => {
    const parsed = BrewerFrontmatter.parse({
      ...taster,
      inputs: [{ name: 'plan', from: 'step:plan' }],
    });
    assert.deepEqual((parsed as { inputs?: unknown }).inputs, [
      { name: 'plan', from: 'step:plan', trusted: false },
    ]);
  });

  const invalid: [string, unknown][] = [
    [
      'setup, which moved to the repository in foedrum.jsonc (ADR 0023)',
      { ...cooper, setup: 'npm ci' },
    ],
    ['setup with a timeout', { ...cooper, setup: { command: 'npm ci', timeout: '10m' } }],
    ['an unknown field', { ...taster, temperature: 0.2 }],
    ['no name', { ...taster, name: undefined }],
    ['a name that is not path-safe', { ...taster, name: 'Taster' }],
    ['an empty description', { ...taster, description: '' }],
    ['version zero', { ...taster, version: 0 }],
    ['a fractional version', { ...taster, version: 1.5 }],
    ['a model alias with a space', { ...taster, model: 'opus 5' }],
    ['an upper-case model alias', { ...taster, model: 'Opus' }],
    ['an unknown effort', { ...taster, effort: 'extreme' }],
    [
      'an output doc that is not path-safe',
      { ...taster, output: { doc: '../x.md', schema: 'review' } },
    ],
    [
      'an output schema name with a dash',
      { ...taster, output: { doc: 'r.md', schema: 'my-review' } },
    ],
    ['an unknown product', { ...taster, produces: 'pullRequest' }],
    ['AskUserQuestion in the allowlist', { ...taster, tools: { allow: ['AskUserQuestion'] } }],
    ['an invalid allowlist rule', { ...taster, tools: { allow: ['Bash(git diff*'] } }],
    ['no allowlist', { ...taster, tools: { deny: ['WebFetch'] } }],
    ['an unknown context', { ...taster, context: 'full' }],
    ['an unknown access', { ...taster, access: 'admin' }],
    ['an unknown tree', { ...taster, tree: 'main' }],
    ['a writing brewer in a read-only checkout', { ...cooper, tree: 'checkout' }],
    ['git settings on a read-only brewer', { ...taster, git: { commit: false } }],
    ['commits from a read-only brewer', { ...taster, produces: 'commits' }],
    ['commits from a brewer that does not commit', { ...cooper, git: { commit: false } }],
    [
      'requiresCommits on a brewer that produces no commits',
      { ...taster, guards: ['requiresCommits'] },
    ],
    ['an unknown guard', { ...taster, guards: ['noSecrets'] }],
    ['a guard listed twice', { ...taster, guards: ['noPush', 'noPush'] }],
    ['no deadline', { ...taster, deadline: undefined }],
    ['an invalid deadline', { ...taster, deadline: '20' }],
    ['zero attempts', { ...taster, maxAttempts: 0 }],
    ['zero turns', { ...taster, maxTurns: 0 }],
    ['zero denials', { ...taster, maxDenials: 0 }],
    ['a stall rule without a limit', { ...taster, stall: {} }],
    ['an unknown retry mode', { ...taster, retryMode: 'again' }],
    ['an environment variable name with a dash', { ...taster, env: { 'MY-VAR': '1' } }],
    ['an environment variable value that is not a string', { ...taster, env: { DEBUG: 1 } }],
    ['an input from an unknown source', { ...taster, inputs: [{ name: 'x', from: 'web:x' }] }],
    [
      'an input from a step id that is not path-safe',
      { ...taster, inputs: [{ name: 'x', from: 'step:Plan' }] },
    ],
    [
      'an input from a file outside the worktree',
      { ...taster, inputs: [{ name: 'x', from: 'file:../x' }] },
    ],
    [
      'a trusted order, which is always untrusted',
      { ...taster, inputs: [{ name: 'o', from: 'order', trusted: true }] },
    ],
    // Out docs are model output that read the order; a trusted source needs an ADR first.
    [
      'a trusted step input',
      { ...taster, inputs: [{ name: 'plan', from: 'step:plan', trusted: true }] },
    ],
    [
      'a trusted repository file, which is repository content (ADR 0018)',
      { ...taster, inputs: [{ name: 'readme', from: 'file:README.md', trusted: true }] },
    ],
    [
      'an input name that is not a variable name',
      { ...taster, inputs: [{ name: 'the plan', from: 'order' }] },
    ],
    [
      'two inputs with the same name',
      {
        ...taster,
        inputs: [
          { name: 'plan', from: 'step:plan' },
          { name: 'plan', from: 'step:gauge' },
        ],
      },
    ],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(value), false);
    });
  }
});
