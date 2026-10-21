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

  it('accepts a writing brewer that commits', () => {
    assert.equal(accepted(cooper), true);
  });

  it('defaults a writing brewer to not committing', () => {
    const { git: _, ...noGit } = cooper;
    const parsed = BrewerFrontmatter.parse({ ...noGit, produces: 'report' });
    assert.deepEqual((parsed as { git?: unknown }).git, { commit: false });
  });

  it('accepts environment variables', () => {
    assert.equal(accepted({ ...taster, env: { DEBUG: '1', MY_VAR: 'x', _UNDER: '' } }), true);
  });

  it('accepts a stall rule with one limit', () => {
    assert.equal(accepted({ ...taster, stall: { turns: 10 } }), true);
    assert.equal(accepted({ ...taster, stall: { minutes: 5 } }), true);
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

  it('accepts an input from a lens (ADR 0098)', () => {
    assert.equal(
      accepted({ ...taster, inputs: [{ name: 'focus', from: 'lens:test-design' }] }),
      true,
    );
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
      'an input from a lens name that is not path-safe',
      { ...taster, inputs: [{ name: 'x', from: 'lens:../security' }] },
    ],
    [
      'an input from a lens name in capitals',
      { ...taster, inputs: [{ name: 'x', from: 'lens:Bad' }] },
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
    // #167: a push with git's options before it gets past every deny rule (ADR 0062).
    [
      'a shell rule that reaches git with no fixed subcommand',
      { ...taster, tools: { allow: ['Read', 'Bash(git *)'] } },
    ],
    ['a whole shell', { ...taster, tools: { allow: ['Read', 'PowerShell'] } }],
    // #204: gh answers from the maintainer's login in the OS keyring (ADR 0082).
    [
      'a shell rule that starts gh',
      { ...taster, tools: { allow: ['Read', 'Bash(gh pr view *)'] } },
    ],
    [
      'gh after a wrapper',
      { ...taster, tools: { allow: ['Read', 'PowerShell(env gh api user)'] } },
    ],
    // #135: Claude Code never consults a path rule for these tools (ADR 0093).
    ['a Write path rule', { ...taster, tools: { allow: ['Read', 'Write(docs/**)'] } }],
    ['a MultiEdit path rule', { ...taster, tools: { allow: ['Read', 'MultiEdit(docs/**)'] } }],
    ['a NotebookEdit path rule', { ...taster, tools: { allow: ['NotebookEdit(a.ipynb)'] } }],
    ['a Glob path rule', { ...taster, tools: { allow: ['Glob(src/**)'] } }],
    ['a Write path rule in deny', { ...taster, tools: { allow: ['Read'], deny: ['Write(x)'] } }],
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

// Names that would undo the brewer's minimal environment, its sandbox or its credentials. The
// runner applies its own variables last (the real guarantee); the schema catches mistakes early.
// #135: the brewer file says what to write instead, when it loads (ADR 0093).
describe('BrewerFrontmatter file-tool path rules', () => {
  for (const [rule, instead] of [
    ['Write(docs/**)', 'Edit(docs/**)'],
    ['Glob(src/**)', 'Read(src/**)'],
  ] as const) {
    it(`refuses ${rule}, naming ${instead}`, () => {
      const result = BrewerFrontmatter.safeParse({ ...taster, tools: { allow: [rule] } });
      assert.equal(result.success, false);
      assert.match(result.error?.message ?? '', new RegExp(instead.replace(/[()*]/g, '\\$&')));
    });
  }
});

describe('BrewerFrontmatter env', () => {
  const reserved: [string, string][] = [
    ['NODE_*', 'NODE_OPTIONS'],
    ['npm_config_*', 'NPM_CONFIG_IGNORE_SCRIPTS'],
    ['PATH', 'Path'],
    ['PATHEXT', 'PATHEXT'],
    ['COMSPEC', 'ComSpec'],
    ['SYSTEMROOT', 'SystemRoot'],
    ['HOME', 'HOME'],
    ['USERPROFILE', 'USERPROFILE'],
    ['APPDATA', 'APPDATA'],
    ['ANTHROPIC_*', 'ANTHROPIC_BASE_URL'],
    ['CLAUDE_*', 'CLAUDE_CONFIG_DIR'],
    ['GIT_*', 'GIT_SSH_COMMAND'],
    ['SSH_*', 'SSH_AUTH_SOCK'],
    ['LD_*', 'LD_PRELOAD'],
    ['DYLD_*', 'DYLD_INSERT_LIBRARIES'],
    ['BASH_ENV', 'BASH_ENV'],
    ['ENV', 'env'],
    ['*_PROXY', 'https_proxy'],
    ['*_PROXY without a scheme', 'NO_PROXY'],
    ['a GitHub token (ADR 0109)', 'GH_TOKEN'],
    ['a GitHub token (ADR 0109)', 'github_token'],
    ['a GitHub token (ADR 0109)', 'GH_ENTERPRISE_TOKEN'],
    ['a GitHub token (ADR 0109)', 'GITHUB_ENTERPRISE_TOKEN'],
  ];
  for (const [family, name] of reserved) {
    it(`rejects ${family} (${name})`, () => {
      assert.equal(accepted({ ...taster, env: { [name]: 'x' } }), false);
    });
  }

  it('accepts names that only start or end like a reserved one', () => {
    const env = {
      NODEJS_LOG: '1',
      HOMEPAGE: 'x',
      ENVIRONMENT: 'ci',
      GITHUB_REF: 'x',
      GITHUB_TOKEN_PATH: 'x',
      MY_GH_TOKEN: 'x',
      PROXY: 'x',
      PATHS: 'x',
    };
    assert.equal(accepted({ ...taster, env }), true);
  });

  it('rejects names that differ only in case', () => {
    assert.equal(accepted({ ...taster, env: { MY_VAR: '1', My_Var: '2' } }), false);
  });

  it('says a GitHub token is refused because a push could carry it, not that the runner sets it', () => {
    const message = BrewerFrontmatter.safeParse({ ...taster, env: { GH_TOKEN: 'x' } }).error
      ?.message;
    assert.match(message ?? '', /GitHub token/);
    assert.doesNotMatch(message ?? '', /runner sets/);
  });
});
