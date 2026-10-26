import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BreweryConfig, githubHostOf } from '../../src/schemas/brewery-config.ts';
import { readJsonc } from '../../src/schemas/read.ts';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'config', 'foedrum.jsonc');

const checks = {
  build: null,
  typecheck: null,
  lint: 'npm run lint',
  format: null,
  test: 'npm test',
};

const config = (repository: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({
  permissionCeiling: ['Bash(npm *)'],
  repositories: { 'acme/web': { checks, ...repository } },
  ...fields,
});

const accepted = (value: unknown): boolean => BreweryConfig.safeParse(value).success;

describe('BreweryConfig', () => {
  it('accepts the example foedrum.jsonc, with its comments and $schema', () => {
    const result = readJsonc(readFileSync(fixture, 'utf8'), BreweryConfig);
    assert.equal(result.valid, true, result.valid ? '' : result.reason);
  });

  it('fills in the defaults of a repository and the ceiling', () => {
    assert.deepEqual(BreweryConfig.parse({ repositories: { 'acme/web': { checks } } }), {
      permissionCeiling: [],
      repositories: { 'acme/web': { checks, tools: [], houseYeast: 'repo' } },
    });
  });

  it('accepts a Brewery without repositories', () => {
    assert.equal(accepted({ repositories: {} }), true);
  });

  it('accepts a TAP report on standard output or in a file, and a JUnit XML file', () => {
    for (const testReport of [
      { format: 'tap' },
      { format: 'tap', path: 'reports/tests.tap' },
      { format: 'junit', path: 'reports/junit.xml' },
    ]) {
      assert.equal(accepted(config({ testReport })), true, JSON.stringify(testReport));
    }
  });

  it('accepts repository tools within the permission ceiling', () => {
    assert.equal(accepted(config({ tools: ['Bash(npm test*)', 'Bash(npm run lint*)'] })), true);
  });

  // The ceiling bounds what a repository adds; it is not an allowlist (ADR 0062, ADR 0082).
  it('accepts a ceiling of every shell command, and rules that only look like gh', () => {
    assert.equal(
      accepted(config({ tools: ['Bash(npm test)'] }, { permissionCeiling: ['Bash(*)'] })),
      true,
    );
    assert.equal(
      accepted(
        config(
          {},
          {
            permissionCeiling: [
              'Bash(ghc *)',
              'Bash(cat gh.txt)',
              'PowerShell(npm run gh)',
              'Bash(env *)',
            ],
          },
        ),
      ),
      true,
    );
  });

  it('accepts a repository whose issues the intake polls, under a short alias (ADR 0043)', () => {
    const intake = { labels: ['foedrum', 'ready'], milestone: 'v2' };
    assert.deepEqual(BreweryConfig.parse(config({ alias: 'web', intake })).repositories, {
      'acme/web': { checks, alias: 'web', intake, tools: [], houseYeast: 'repo' },
    });
    assert.equal(accepted(config({ alias: 'w2', intake: { labels: ['foedrum'] } })), true);
    assert.equal(accepted(config({ alias: 'a'.repeat(20) })), true);
  });

  it('refuses an alias two repositories share, pointing at the second', () => {
    const result = BreweryConfig.safeParse({
      repositories: {
        'acme/web': { checks, alias: 'app' },
        'acme/api': { checks, alias: 'app' },
      },
    });
    assert.equal(result.success, false);
    assert.deepEqual(
      result.error?.issues.map(({ path, message }) => ({ path, message })),
      [
        {
          path: ['repositories', 'acme/api', 'alias'],
          message: 'The alias app is already the alias of acme/web',
        },
      ],
    );
  });

  const missingCheck = Object.fromEntries(
    Object.entries(checks).filter(([key]) => key !== 'format'),
  );
  const invalid: [string, unknown][] = [
    ['no repositories', { permissionCeiling: [] }],
    ['an unknown field', { repositories: {}, parallelism: 2 }],
    ['a $schema that is not a string', { $schema: 1, repositories: {} }],
    ['a repository key that is not owner/name', { repositories: { web: { checks } } }],
    ['a repository key with a parent segment', { repositories: { 'acme/..': { checks } } }],
    [
      'two repositories that differ only in case',
      { repositories: { 'acme/web': { checks }, 'Acme/Web': { checks } } },
    ],
    ['a repository without checks', { repositories: { 'acme/web': {} } }],
    ['a missing check, which must be null when not available', config({ checks: missingCheck })],
    ['an unknown check', config({ checks: { ...checks, e2e: 'npm run e2e' } })],
    ['an empty check command', config({ checks: { ...checks, lint: '' } })],
    ['a check command of more than one line', config({ checks: { ...checks, lint: 'a\nb' } })],
    ['an unknown repository field', config({ release: 'tag' })],
    ['an unknown house-yeast location', config({ houseYeast: 'nowhere' })],
    ['an unknown test report format', config({ testReport: { format: 'xunit', path: 'r.xml' } })],
    ['a JUnit report without a path', config({ testReport: { format: 'junit' } })],
    ['an absolute report path', config({ testReport: { format: 'junit', path: '/tmp/r.xml' } })],
    [
      'a report path outside the worktree',
      config({ testReport: { format: 'tap', path: '../r.tap' } }),
    ],
    ['a report path with a backslash', config({ testReport: { format: 'tap', path: 'a\\r.tap' } })],
    [
      'a test report without a test check',
      config({ checks: { ...checks, test: null }, testReport: { format: 'tap' } }),
    ],
    ['a setup without a timeout', config({ setup: { command: 'npm ci' } })],
    ['a setup without a command', config({ setup: { timeout: '10m' } })],
    ['a setup with an invalid timeout', config({ setup: { command: 'npm ci', timeout: 'ten' } })],
    ['a setup as a plain command', config({ setup: 'npm ci' })],
    ['AskUserQuestion in the repository tools', config({ tools: ['AskUserQuestion'] })],
    ['an invalid tool rule', config({ tools: ['Bash(npm test*'] })],
    ['an invalid ceiling rule', config({}, { permissionCeiling: ['Bash('] })],
    ['an alias in upper case', config({ alias: 'Web' })],
    ['an alias that starts with a digit, as a Brewery batch id does', config({ alias: '1web' })],
    ['an alias with a hyphen, which would split its batch ids', config({ alias: 'my-web' })],
    ['an alias of more than 20 characters', config({ alias: 'a'.repeat(21) })],
    ['an intake without an alias', config({ intake: { labels: ['foedrum'] } })],
    ['an intake without labels', config({ alias: 'web', intake: { labels: [] } })],
    ['an intake with an empty label', config({ alias: 'web', intake: { labels: [''] } })],
    [
      'an intake with an empty milestone',
      config({ alias: 'web', intake: { labels: ['a'], milestone: '' } }),
    ],
    ['an unknown intake field', config({ alias: 'web', intake: { labels: ['a'], author: 'x' } })],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(value), false);
    });
  }

  // #204: gh answers from the maintainer's login in the OS keyring, so neither the ceiling nor a
  // repository's tools name it, even under a ceiling of every command (ADR 0082).
  const gh: [string, unknown, (string | number)[]][] = [
    [
      'gh in the ceiling',
      config({}, { permissionCeiling: ['Bash(gh *)'] }),
      ['permissionCeiling', 0],
    ],
    [
      'gh by path in the ceiling',
      config({}, { permissionCeiling: ['Read', 'PowerShell(C:\\Tools\\gh.exe api *)'] }),
      ['permissionCeiling', 1],
    ],
    [
      'gh after a wrapper in the ceiling',
      config({}, { permissionCeiling: ['Bash(env gh pr list)'] }),
      ['permissionCeiling', 0],
    ],
    [
      'gh by path after a wrapper in the ceiling',
      config({}, { permissionCeiling: ['Bash(env /usr/bin/gh pr list)'] }),
      ['permissionCeiling', 0],
    ],
    // A star right after the name still names gh (review of #225).
    [
      'gh with a star in the ceiling',
      config({}, { permissionCeiling: ['Bash(gh*)'] }),
      ['permissionCeiling', 0],
    ],
    [
      'gh by path with a star in the repository tools',
      config({ tools: ['Bash(/usr/bin/gh*)'] }, { permissionCeiling: ['Bash(*)'] }),
      ['repositories', 'acme/web', 'tools', 0],
    ],
    [
      'gh in the repository tools, under a ceiling of every command',
      config({ tools: ['Bash(npm test)', 'Bash(gh pr list)'] }, { permissionCeiling: ['Bash(*)'] }),
      ['repositories', 'acme/web', 'tools', 1],
    ],
  ];
  for (const [what, value, path] of gh) {
    it(`rejects ${what}, pointing at the rule`, () => {
      const result = BreweryConfig.safeParse(value);
      assert.equal(result.success, false);
      assert.deepEqual(
        result.error?.issues.map((issue) => issue.path),
        [path],
      );
      assert.match(result.error?.message ?? '', /only the engine talks to GitHub/);
    });
  }

  // #439: a package manager's runner and its other subcommands are read as the program they run,
  // so gh behind them is named; the ceiling stays no allowlist (ADR 0165).
  const refusesGh = (value: unknown, path: (string | number)[]): void => {
    const result = BreweryConfig.safeParse(value);
    assert.equal(result.success, false);
    assert.deepEqual(
      result.error?.issues.map((issue) => issue.path),
      [path],
    );
    assert.match(result.error?.message ?? '', /only the engine talks to GitHub/);
  };

  it('rejects gh after npm exec in the ceiling, pointing at the rule', () => {
    refusesGh(config({}, { permissionCeiling: ['Bash(npm exec gh *)'] }), ['permissionCeiling', 0]);
  });

  it('rejects gh after pnpm in the ceiling, pointing at the rule', () => {
    refusesGh(config({}, { permissionCeiling: ['Bash(pnpm gh *)'] }), ['permissionCeiling', 0]);
  });

  it('rejects gh after yarn dlx in the ceiling, pointing at the rule', () => {
    refusesGh(config({}, { permissionCeiling: ['Bash(yarn dlx gh pr list)'] }), [
      'permissionCeiling',
      0,
    ]);
  });

  it('rejects gh behind corepack and pnpm in the ceiling, pointing at the rule', () => {
    refusesGh(config({}, { permissionCeiling: ['Bash(corepack pnpm gh *)'] }), [
      'permissionCeiling',
      0,
    ]);
  });

  it('rejects gh after an equals sign in the ceiling, pointing at the rule', () => {
    refusesGh(config({}, { permissionCeiling: ['Bash(npx --call=gh auth token)'] }), [
      'permissionCeiling',
      0,
    ]);
  });

  it('rejects gh after bunx in the ceiling, pointing at the rule', () => {
    refusesGh(config({}, { permissionCeiling: ['PowerShell(bunx gh auth token)'] }), [
      'permissionCeiling',
      0,
    ]);
  });

  it('rejects gh after npm exec in the repository tools, under a ceiling of every command', () => {
    refusesGh(
      config(
        { tools: ['Bash(npm test)', 'Bash(npm exec gh pr list)'] },
        { permissionCeiling: ['Bash(*)'] },
      ),
      ['repositories', 'acme/web', 'tools', 1],
    );
  });

  it('rejects gh after pnpm in the repository tools, under a ceiling of every command', () => {
    refusesGh(config({ tools: ['Bash(pnpm gh pr list)'] }, { permissionCeiling: ['Bash(*)'] }), [
      'repositories',
      'acme/web',
      'tools',
      0,
    ]);
  });

  it('rejects gh after pnpm in the repository tools, under a ceiling of npm and pnpm', () => {
    refusesGh(
      config(
        { tools: ['Bash(pnpm gh pr list)'] },
        { permissionCeiling: ['Bash(npm *)', 'Bash(pnpm *)'] },
      ),
      ['repositories', 'acme/web', 'tools', 0],
    );
  });

  // Rules that load today and must keep loading: regression tests for the reading.
  it('accepts Bash(npm *) and Bash(pnpm *) in the ceiling, which is no allowlist', () => {
    assert.equal(accepted(config({}, { permissionCeiling: ['Bash(npm *)'] })), true);
    assert.equal(accepted(config({}, { permissionCeiling: ['Bash(pnpm *)'] })), true);
  });

  it('accepts npm and pnpm scripts in the repository tools, under their ceiling', () => {
    assert.equal(
      accepted(
        config(
          { tools: ['Bash(npm run lint)', 'Bash(pnpm run lint)'] },
          { permissionCeiling: ['Bash(npm *)', 'Bash(pnpm *)'] },
        ),
      ),
      true,
    );
  });

  const beyond: [string, unknown, (string | number)[]][] = [
    [
      'a tool broader than the ceiling',
      config({ tools: ['Bash(npm test*)', 'Bash(*)'] }),
      ['repositories', 'acme/web', 'tools', 1],
    ],
    [
      'a tool when the ceiling is empty',
      config({ tools: ['Read'] }, { permissionCeiling: [] }),
      ['repositories', 'acme/web', 'tools', 0],
    ],
    [
      'a tool when there is no ceiling',
      { repositories: { 'acme/web': { checks, tools: ['Bash(npm test*)'] } } },
      ['repositories', 'acme/web', 'tools', 0],
    ],
  ];
  for (const [what, value, path] of beyond) {
    it(`rejects ${what}, pointing at the tool`, () => {
      const result = BreweryConfig.safeParse(value);
      assert.equal(result.success, false);
      assert.deepEqual(
        result.error?.issues.map((issue) => issue.path),
        [path],
      );
      assert.match(result.error?.message ?? '', /permission ceiling/);
    });
  }
});

/** The fields `serve` reads (ADR 0063). */
interface ServeFields {
  brewery?: string;
  githubApi?: string;
  repositories: Record<string, { source?: string; base?: string }>;
}

describe('BreweryConfig for foedrum serve (ADR 0063)', () => {
  it('names the Brewery and the GitHub API, and each repository its source and base', () => {
    const parsed = BreweryConfig.safeParse(
      config(
        { source: 'managed', base: 'release/2.x' },
        { brewery: 'acme/brewery', githubApi: 'https://github.example.com/api/v3' },
      ),
    ).data as ServeFields | undefined;
    assert.equal(parsed?.brewery, 'acme/brewery');
    assert.equal(parsed?.githubApi, 'https://github.example.com/api/v3');
    assert.equal(parsed?.repositories['acme/web']?.source, 'managed');
    assert.equal(parsed?.repositories['acme/web']?.base, 'release/2.x');
  });

  it('leaves them out when the file does, so a config without them stays valid', () => {
    const parsed = BreweryConfig.parse(config({})) as ServeFields;
    assert.equal(parsed.brewery, undefined);
    assert.equal(parsed.githubApi, undefined);
    assert.equal(parsed.repositories['acme/web']?.source, undefined);
    assert.equal(parsed.repositories['acme/web']?.base, undefined);
  });

  it('refuses a Brewery that is not owner/name', () => {
    assert.equal(accepted(config({}, { brewery: 'brewery' })), false);
  });

  it('refuses a source other than local or managed', () => {
    assert.equal(accepted(config({ source: 'remote' })), false);
  });

  it('refuses a base git would read as an option, a range or no branch', () => {
    for (const base of [
      '-main',
      'main..dev',
      'feat//x',
      'main/',
      'main.lock',
      'a b',
      '',
      'x@{1}',
    ]) {
      assert.equal(accepted(config({ base })), false, base);
    }
  });

  // gh takes a host, not a URL (ADR 0073): only an API root gh works out from a host will do.
  it('takes only an API root gh reaches by its host, and names that host', () => {
    for (const [githubApi, host] of [
      ['https://api.github.com', 'github.com'],
      ['https://api.github.com/', 'github.com'],
      ['https://ghe.example/api/v3', 'ghe.example'],
      ['https://GHE.example/api/v3/', 'ghe.example'],
      ['http://api.github.localhost', 'github.localhost'],
    ]) {
      assert.equal(accepted(config({}, { githubApi })), true, githubApi);
      assert.equal(githubHostOf(githubApi ?? ''), host, githubApi);
    }
    for (const githubApi of [
      'http://127.0.0.1:4000',
      'http://localhost:4000/api',
      'http://api.github.com',
      'https://api.github.com/api/v3',
      'https://ghe.example',
      'https://ghe.example/api',
      'https://ghe.example:8443/api/v3',
      'https://api.github.localhost',
      'https://github.localhost/api/v3',
      'https://x.github.localhost/api/v3',
      'ftp://api.github.com',
      'https://user:secret@api.github.com',
      'https://api.github.com/?x=1',
      'not a url',
    ]) {
      assert.equal(accepted(config({}, { githubApi })), false, githubApi);
      assert.equal(githubHostOf(githubApi), undefined, githubApi);
    }
  });
});

describe('BreweryConfig for the intake in foedrum serve (ADR 0068)', () => {
  it('names the allow-listed users, the concurrency and how often the intake polls', () => {
    const result = BreweryConfig.safeParse(
      config({}, { users: ['ann', 'Bob-2'], concurrency: 3, pollEvery: '2m' }),
    );
    assert.equal(result.success, true, result.error?.message);
    assert.deepStrictEqual(
      [result.data?.users, result.data?.concurrency, result.data?.pollEvery],
      [['ann', 'Bob-2'], 3, '2m'],
    );
  });

  it('leaves them out when the file does, so a config without them stays valid', () => {
    const parsed = BreweryConfig.parse(config({}));
    assert.deepStrictEqual(
      [parsed.users, parsed.concurrency, parsed.pollEvery],
      [undefined, undefined, undefined],
    );
  });

  it('refuses a user that is no GitHub login', () => {
    for (const user of ['', '-ann', 'ann-', 'an--n', 'ann bob', 'a'.repeat(40), 'ann/x']) {
      assert.equal(accepted(config({}, { users: [user] })), false, user);
    }
    assert.equal(accepted(config({}, { users: ['a'.repeat(39)] })), true);
  });

  it('takes a concurrency of 1 to 20 whole batches', () => {
    for (const concurrency of [1, 20]) {
      assert.equal(accepted(config({}, { concurrency })), true, String(concurrency));
    }
    for (const concurrency of [0, 21, 1.5, -1, '2']) {
      assert.equal(accepted(config({}, { concurrency })), false, String(concurrency));
    }
  });

  it('takes an openOrders of 1 to 20 whole orders, and leaves it out when the file does (ADR 0217)', () => {
    for (const openOrders of [1, 20]) {
      const parsed = BreweryConfig.parse(config({}, { openOrders })) as { openOrders?: number };
      assert.equal(parsed.openOrders, openOrders, String(openOrders));
    }
    for (const openOrders of [0, 21, 1.5, -1, '2']) {
      assert.equal(accepted(config({}, { openOrders })), false, String(openOrders));
    }
    const parsed = BreweryConfig.parse(config({})) as { openOrders?: number };
    assert.equal(parsed.openOrders, undefined);
  });

  it('polls every 30 seconds at most and every hour at least', () => {
    for (const pollEvery of ['30s', '60s', '5m', '1h', '3600s']) {
      assert.equal(accepted(config({}, { pollEvery })), true, pollEvery);
    }
    for (const pollEvery of ['29s', '10s', '61m', '2h', '1d', '60', 'soon']) {
      assert.equal(accepted(config({}, { pollEvery })), false, pollEvery);
    }
  });
});

describe('BreweryConfig: sensitive paths (ADR 0201)', () => {
  it('takes a list of path globs in a repository, kept as written', () => {
    const sensitivePaths = [
      '.github/workflows/**',
      'src/auth/**',
      'db/migrations/*.sql',
      'a b/[ab]*',
      // Near-misses of the refusals: two dots inside a name, a ! past the start.
      'a..b/**',
      'src/[!x]*.ts',
    ];
    const parsed = BreweryConfig.parse(config({ sensitivePaths }));
    assert.deepEqual(parsed.repositories['acme/web']?.sensitivePaths, sensitivePaths);
  });

  it('has no default: a repository without the field names none', () => {
    const parsed = BreweryConfig.parse(config({}));
    assert.equal(parsed.repositories['acme/web']?.sensitivePaths, undefined);
    assert.equal(accepted(config({ sensitivePaths: [] })), true);
  });

  it('refuses a glob that would match nothing git names, or not what it seems to, with one line', () => {
    for (const glob of [
      '',
      ' ',
      '/src/**',
      '!src/auth/**',
      'src\\auth\\**',
      '../x',
      'src/./a',
      'src/../a',
      'src/..',
    ]) {
      const result = BreweryConfig.safeParse(config({ sensitivePaths: ['ok/**', glob] }));
      assert.equal(result.success, false, glob);
      assert.deepEqual(
        result.error?.issues.map(({ path, message }) => ({ path, message })),
        [
          {
            path: ['repositories', 'acme/web', 'sensitivePaths', 1],
            message:
              'Must be a path glob relative to the repository, with / between folders, such as "src/auth/**"',
          },
        ],
        glob,
      );
    }
  });

  it('refuses a list that is not one of strings', () => {
    assert.equal(accepted(config({ sensitivePaths: 'src/**' })), false);
    assert.equal(accepted(config({ sensitivePaths: [1] })), false);
  });
});
