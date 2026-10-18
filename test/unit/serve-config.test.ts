// What `foedrum serve` needs to know, read from the Brewery's checkout and this machine (ADR 0063):
// pure, over the files' text, the environment and doctor's diagnosis.

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { diagnose } from '../../src/cli/doctor.ts';
import { type ServeInputs, serveSetup } from '../../src/cli/serve-config.ts';
import { linux, windows } from '../helpers/doctor-facts.ts';
import { clone, config, home, local, models, root, serveInputs } from '../helpers/serve-brewery.ts';

const inputs = serveInputs;

const ready = (given: ServeInputs) => {
  const result = serveSetup(given);
  assert.equal(result.kind, 'ready', result.kind === 'refused' ? result.problems.join('\n') : '');
  return result.kind === 'ready' ? result.setup : assert.fail();
};
const refused = (given: ServeInputs): string[] => {
  const result = serveSetup(given);
  return result.kind === 'refused' ? result.problems : assert.fail('serve was not refused');
};

describe('serveSetup', () => {
  it('reads everything serve needs, with the defaults of ADR 0063', () => {
    const setup = ready(inputs());
    const workRoot = join(home, '.foedrum', 'acme.brewery');
    assert.equal(setup.brewery, 'Acme/Brewery');
    assert.equal(setup.workRoot, workRoot);
    assert.equal(setup.store, join(root, '.foedrum', 'index.db'));
    assert.equal(setup.stateWorktree, join(workRoot, 'state'));
    assert.deepStrictEqual(setup.repositories, [
      { repo: 'acme/web', source: 'local', base: 'origin/main', clone, tools: ['Bash(npm test*)'] },
    ]);
    assert.deepStrictEqual(setup.github, { api: 'https://api.github.com', token: 'ghp_serve' });
    assert.equal(setup.claude, '/home/brewer/.local/bin/claude');
    assert.equal(setup.sandbox, true);
    assert.deepStrictEqual(setup.brewerEnv, {
      base: { PATH: '/usr/bin', HOME: home },
      forced: { npm_config_ignore_scripts: 'true' },
    });
    assert.deepStrictEqual(setup.models.models, { quick: 'claude-haiku-5-5' });
    assert.notEqual(setup.recipes.find('stout'), undefined);
    assert.equal(setup.brewers.find('stout', 'brew')?.brewer.name, 'cellarman');
  });

  it("takes the machine's work root, GITHUB_TOKEN, the Brewery's API and each repository's source and base", () => {
    const workRoot = resolve('work');
    const setup = ready(
      inputs({
        env: { GITHUB_TOKEN: 'ghp_other' },
        files: {
          ...inputs().files,
          config: config(
            { githubApi: 'http://127.0.0.1:4000' },
            { source: 'managed', base: 'develop' },
          ),
          local: local({ workRoot }),
        },
        diagnosis: diagnose(windows),
      }),
    );
    assert.equal(setup.workRoot, workRoot);
    assert.deepStrictEqual(setup.github, { api: 'http://127.0.0.1:4000', token: 'ghp_other' });
    assert.deepStrictEqual(setup.repositories, [
      {
        repo: 'acme/web',
        source: 'managed',
        base: 'origin/develop',
        clone,
        tools: ['Bash(npm test*)'],
      },
    ]);
    assert.equal(setup.sandbox, false);
  });

  it('finds the clone of a repository whose name the two files spell in another case', () => {
    const setup = ready(
      inputs({
        files: {
          ...inputs().files,
          config: config().replace('"acme/web"', '"Acme/Web"'),
          local: JSON.stringify({ clones: { 'acme/WEB': clone } }),
        },
      }),
    );
    assert.equal(setup.repositories[0]?.clone, clone);
  });

  it('runs without .foedrum/local.jsonc when every repository is managed', () => {
    const setup = ready(
      inputs({
        files: { ...inputs().files, config: config({}, { source: 'managed' }), local: undefined },
      }),
    );
    assert.deepStrictEqual(setup.repositories, [
      { repo: 'acme/web', source: 'managed', base: 'origin/main', tools: ['Bash(npm test*)'] },
    ]);
  });

  it('refuses with one line per problem, all at once', () => {
    assert.deepStrictEqual(
      refused(
        inputs({
          env: {},
          files: { ...inputs().files, config: undefined, models: undefined },
        }),
      ),
      [
        `foedrum.jsonc: not found in ${root}; run foedrum serve in the Brewery's checkout`,
        `models.jsonc: not found in ${root}`,
        "set GH_TOKEN or GITHUB_TOKEN to a GitHub token that can read the Brewery's issues",
      ],
    );
  });

  it('refuses a config without the Brewery, and a local repository without its clone', () => {
    assert.deepStrictEqual(
      refused(
        inputs({
          files: { ...inputs().files, config: config({ brewery: undefined }), local: undefined },
        }),
      ),
      [
        'foedrum.jsonc: name the Brewery with "brewery": "<owner>/<name>" (ADR 0063)',
        '.foedrum/local.jsonc: acme/web has the source local, so name its clone in "clones" (ADR 0063)',
      ],
    );
  });

  it('refuses files that do not pass their schemas', () => {
    const problems = refused(
      inputs({
        files: {
          ...inputs().files,
          config: '{ "repositories": 1 }',
          local: '{ "workRoot": "relative" }',
          models: '{ "models": { "Quick": "x" } }',
        },
      }),
    );
    assert.deepStrictEqual(
      problems.map((problem) => problem.split(':')[0]),
      ['foedrum.jsonc', '.foedrum/local.jsonc', 'models.jsonc'],
    );
  });

  it('refuses a Brewery without a repository: no attempt could get a worktree', () => {
    const empty = JSON.stringify({ brewery: 'acme/brewery', users: ['ann'], repositories: {} });
    assert.deepStrictEqual(refused(inputs({ files: { ...inputs().files, config: empty } })), [
      'foedrum.jsonc: list at least one repository under "repositories" for foedrum serve',
    ]);
  });

  it('refuses a brewer whose model alias models.jsonc does not have', () => {
    assert.deepStrictEqual(
      refused(inputs({ files: { ...inputs().files, models: models('deep') } })),
      [
        'brewers/cellarman.md: models.jsonc has no model for the alias "quick" of the brewer "cellarman"',
      ],
    );
  });

  it("refuses recipe files that do not load, with doctor's line", () => {
    const problems = refused(
      inputs({
        files: {
          ...inputs().files,
          brewery: { recipes: [{ path: 'recipes/stout.jsonc', text: '{' }], brewers: [] },
        },
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(
      problems[0] ?? '',
      /^the Brewery's recipes are not valid: recipes\/stout\.jsonc: /,
    );
  });

  it("refuses what doctor finds missing, with doctor's fix", () => {
    const problems = refused(inputs({ diagnosis: diagnose(linux({ claude: undefined })) }));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^claude/);
  });

  it('takes GH_TOKEN before GITHUB_TOKEN, and GITHUB_TOKEN when GH_TOKEN is empty', () => {
    const both = ready(inputs({ env: { GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y' } }));
    assert.equal(both.github.token, 'ghp_x');
    const empty = ready(inputs({ env: { GH_TOKEN: '', GITHUB_TOKEN: 'ghp_y' } }));
    assert.equal(empty.github.token, 'ghp_y');
  });

  it("keeps no GitHub token in the brewers' environment", () => {
    const setup = ready(
      inputs({ env: { PATH: '/usr/bin', GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y' } }),
    );
    assert.deepStrictEqual(setup.brewerEnv.base, { PATH: '/usr/bin' });
  });

  it('runs the intake for the allow-listed users, one batch at a time, polling every minute (ADR 0068)', () => {
    assert.deepStrictEqual(ready(inputs()).intake, {
      users: ['ann'],
      capacity: 1,
      pollEveryMs: 60_000,
      repositories: [],
    });
  });

  it("takes the concurrency, the polling interval and each repository's intake from foedrum.jsonc", () => {
    const setup = ready(
      inputs({
        files: {
          ...inputs().files,
          config: config(
            { users: ['ann', 'bob'], concurrency: 3, pollEvery: '5m' },
            { alias: 'web', intake: { labels: ['foedrum'], milestone: 'M1' } },
          ),
        },
      }),
    );
    assert.deepStrictEqual(setup.intake, {
      users: ['ann', 'bob'],
      capacity: 3,
      pollEveryMs: 300_000,
      repositories: [
        { repo: 'acme/web', alias: 'web', filter: { labels: ['foedrum'], milestone: 'M1' } },
      ],
    });
  });

  it('refuses a Brewery without an allow-listed user: nothing could be ordered', () => {
    for (const users of [undefined, []]) {
      const problems = refused(inputs({ files: { ...inputs().files, config: config({ users }) } }));
      assert.deepStrictEqual(problems, [
        'foedrum.jsonc: list the GitHub users who may order work under "users" (ADR 0068)',
      ]);
    }
  });
});
