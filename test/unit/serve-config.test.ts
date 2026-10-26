// What `foedrum serve` needs to know, read from the Brewery's checkout and this machine (ADR 0063):
// pure, over the files' text, the environment and doctor's diagnosis.

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { modelOf } from '../../src/brewers/attempt-plan.ts';
import { diagnose } from '../../src/cli/doctor.ts';
import {
  attemptClone,
  type ServeInputs,
  type ServeSetup,
  serveSetup,
} from '../../src/cli/serve-config.ts';
import { brewerForcedEnv } from '../../src/engine/brewer-env.ts';
import type { BreweryFile } from '../../src/engine/recipe-files.ts';
import { linux, loggedIn, macos, ran, windows } from '../helpers/doctor-facts.ts';
import {
  brewer as cellarman,
  clone,
  config,
  home,
  local,
  models,
  recipe,
  root,
  serveInputs,
} from '../helpers/serve-brewery.ts';

const inputs = serveInputs;
// What the helper's foedrum.jsonc maps acme/web's checks to.
const webChecks = { build: null, typecheck: null, lint: null, format: null, test: 'npm test' };

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
      {
        repo: 'acme/web',
        source: 'local',
        base: 'origin/main',
        clone,
        tools: ['Bash(npm test*)'],
        checks: webChecks,
      },
    ]);
    assert.deepStrictEqual(setup.github, { hostname: 'github.com' });
    assert.equal(setup.claude, '/home/brewer/.local/bin/claude');
    assert.equal(setup.sandbox, true);
    assert.deepStrictEqual(setup.brewerEnv, {
      base: { PATH: '/usr/bin', HOME: home },
      forced: brewerForcedEnv(),
    });
    assert.deepStrictEqual(setup.models.models, { quick: 'claude-haiku-5-5' });
    assert.notEqual(setup.recipes.find('stout'), undefined);
    assert.equal(setup.brewers.find('stout', 'brew')?.brewer.name, 'cellarman');
    // The check steps of the recipes, which the check runner runs (ADR 0069).
    assert.deepStrictEqual(setup.checks.find('porter', 'green'), ['test']);
    assert.equal(setup.checks.find('porter', 'brew'), undefined);
  });

  it("takes the machine's work root, the host of the Brewery's API and each repository's source and base", () => {
    const workRoot = resolve('work');
    const setup = ready(
      inputs({
        files: {
          ...inputs().files,
          config: config(
            { githubApi: 'https://ghe.example/api/v3' },
            { source: 'managed', base: 'develop' },
          ),
          local: local({ workRoot }),
        },
        diagnosis: diagnose(windows),
      }),
    );
    assert.equal(setup.workRoot, workRoot);
    assert.deepStrictEqual(setup.github, { hostname: 'ghe.example' });
    assert.deepStrictEqual(setup.repositories, [
      {
        repo: 'acme/web',
        source: 'managed',
        base: 'origin/develop',
        clone,
        tools: ['Bash(npm test*)'],
        checks: webChecks,
      },
    ]);
    assert.equal(setup.sandbox, false);
  });

  it("passes on the Brewery's house-yeast rule files and where each repository keeps its own (ADR 0169)", () => {
    const rules = [{ path: 'house-yeast/cents.md', text: 'cents' }];
    const setup = ready(
      inputs({
        files: {
          ...inputs().files,
          config: config({}, { houseYeast: 'brewery' }),
          houseYeast: rules,
        },
      }),
    );
    assert.deepStrictEqual(setup.houseYeast, rules);
    assert.equal(setup.repositories[0]?.houseYeast, 'brewery');
    assert.equal(ready(inputs()).repositories[0]?.houseYeast, undefined);
  });

  it("passes on each repository's sensitive paths, and none when it names none (ADR 0201)", () => {
    const sensitivePaths = ['.github/workflows/**', 'src/auth/**'];
    const setup = ready(
      inputs({ files: { ...inputs().files, config: config({}, { sensitivePaths }) } }),
    );
    assert.deepStrictEqual(setup.repositories[0]?.sensitivePaths, sensitivePaths);
    assert.equal(ready(inputs()).repositories[0]?.sensitivePaths, undefined);
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

  it("names the clone a repository's attempt worktrees are added to, as serve does (ADR 0092)", () => {
    const files = { config: config(), local: local() };
    assert.equal(attemptClone(files, home, 'acme/web'), clone);
    // Another spelling of the name is the same repository.
    assert.equal(attemptClone(files, home, 'Acme/WEB'), clone);
    const managed = { config: config({}, { source: 'managed' }), local: undefined };
    assert.equal(
      attemptClone(managed, home, 'acme/web'),
      join(home, '.foedrum', 'acme.brewery', 'acme.web', 'clone.git'),
    );
    const workRoot = resolve('work');
    assert.equal(
      attemptClone({ ...managed, local: local({ workRoot }) }, home, 'acme/web'),
      join(workRoot, 'acme.web', 'clone.git'),
    );
  });

  it('names no clone for a repository the files do not name, or files that do not read', () => {
    const files = { config: config(), local: local() };
    assert.equal(attemptClone(files, home, 'acme/other'), undefined);
    assert.equal(attemptClone({ ...files, local: undefined }, home, 'acme/web'), undefined);
    assert.equal(attemptClone({ ...files, config: undefined }, home, 'acme/web'), undefined);
    assert.equal(attemptClone({ ...files, config: '{ not jsonc' }, home, 'acme/web'), undefined);
    assert.equal(attemptClone({ ...files, local: '{ "clones": 1 }' }, home, 'acme/web'), undefined);
    // A managed clone lies in the work root, which needs the Brewery's name.
    const noBrewery = config({ brewery: undefined }, { source: 'managed' });
    assert.equal(
      attemptClone({ config: noBrewery, local: undefined }, home, 'acme/web'),
      undefined,
    );
  });

  it('runs without .foedrum/local.jsonc when every repository is managed', () => {
    const setup = ready(
      inputs({
        files: { ...inputs().files, config: config({}, { source: 'managed' }), local: undefined },
      }),
    );
    assert.deepStrictEqual(setup.repositories, [
      {
        repo: 'acme/web',
        source: 'managed',
        base: 'origin/main',
        tools: ['Bash(npm test*)'],
        checks: webChecks,
      },
    ]);
  });

  it('refuses with one line per problem, all at once', () => {
    // models.jsonc is optional (ADR 0153), so the second problem is a file that does not read.
    const problems = refused(
      inputs({
        env: {},
        files: { ...inputs().files, config: undefined, models: '{' },
      }),
    );
    assert.equal(problems.length, 2);
    assert.equal(
      problems[0],
      `foedrum.jsonc: not found in ${root}; run foedrum serve in the Brewery's checkout`,
    );
    assert.match(problems[1] ?? '', /^models\.jsonc: /);
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

  it('refuses a default brewer whose model alias models.jsonc does not have, unless the Brewery replaces it (ADR 0098)', () => {
    const { brewery } = inputs().files;
    const [own] = brewery.brewers;
    assert.ok(own !== undefined);
    const fromDefaults = { ...own, path: 'defaults/brewers/cellarman.md' };
    const withDefault = (brewers: typeof brewery.brewers) => ({
      files: {
        ...inputs().files,
        models: models('deep'),
        brewery: { ...brewery, brewers, defaults: { brewers: [fromDefaults] } },
      },
    });
    assert.deepStrictEqual(refused(inputs(withDefault([]))), [
      'defaults/brewers/cellarman.md: models.jsonc has no model for the alias "quick" of the brewer "cellarman"',
    ]);
    // The Brewery's own cellarman is checked instead.
    assert.deepStrictEqual(refused(inputs(withDefault([own]))), [
      'brewers/cellarman.md: models.jsonc has no model for the alias "quick" of the brewer "cellarman"',
    ]);
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

  // Foedrum reaches GitHub only through gh's own login (ADR 0073).
  it('refuses without a gh login for its host, with the line to run', () => {
    const facts = linux();
    facts.github = {
      ...loggedIn('ghe.example'),
      login: ran(
        '',
        'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
        1,
      ),
    };
    assert.deepStrictEqual(refused(inputs({ diagnosis: diagnose(facts) })), [
      'gh is not logged in to ghe.example: run gh auth login --hostname ghe.example',
    ]);
  });

  it("refuses what doctor finds missing, with doctor's fix", () => {
    const problems = refused(inputs({ diagnosis: diagnose(linux({ claude: undefined })) }));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^claude/);
  });

  // Foedrum reaches GitHub only through gh's own login (ADR 0073).
  it('needs no GitHub token, and keeps none that the environment has', () => {
    const without = ready(inputs({ env: {} }));
    assert.deepStrictEqual(without.github, { hostname: 'github.com' });
    const withTokens = ready(inputs({ env: { GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y' } }));
    assert.doesNotMatch(JSON.stringify(withTokens), /ghp_x|ghp_y/);
  });

  it("keeps no GitHub token in the brewers' environment", () => {
    const setup = ready(
      inputs({ env: { PATH: '/usr/bin', GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y' } }),
    );
    assert.deepStrictEqual(setup.brewerEnv.base, { PATH: '/usr/bin' });
  });

  // ADR 0160: a variable that moves a login moves it out of the paths the sandbox hides.
  it('keeps where the environment moves the logins the sandbox hides', () => {
    const setup = ready(
      inputs({
        env: { PATH: '/usr/bin', GH_CONFIG_DIR: '/srv/gh', XDG_CONFIG_HOME: '/data/config' },
      }),
    );
    assert.deepStrictEqual(setup.configDirs, {
      GH_CONFIG_DIR: '/srv/gh',
      XDG_CONFIG_HOME: '/data/config',
    });
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

describe('serveSetup: the isolation level of check steps (ADR 0076)', () => {
  const requires = (minimum: string) => config({ isolation: { minimum } });

  it('refuses a Brewery that requires the sandboxed level when its check steps would run below it, and only then', () => {
    const files = inputs().files;
    const problems = refused(
      inputs({
        platform: 'win32',
        files: { ...files, config: requires('sandboxed') },
        diagnosis: diagnose(windows),
      }),
    );
    assert.deepStrictEqual(problems, [
      'foedrum.jsonc requires the sandboxed isolation level, and check steps would run at permissions only (native Windows has no sandbox for shell commands) (ADR 0076)',
    ]);
    // Where the level is sandboxed, where the Brewery requires no more, or without a check step.
    ready(inputs({ files: { ...files, config: requires('sandboxed') } }));
    const onWindows = { platform: 'win32', diagnosis: diagnose(windows) } as const;
    ready(inputs({ ...onWindows, files: { ...files, config: requires('permissions only') } }));
    const stoutOnly = { ...files.brewery, recipes: files.brewery.recipes.slice(0, 1) };
    ready(
      inputs({
        ...onWindows,
        files: { ...files, config: requires('sandboxed'), brewery: stoutOnly },
      }),
    );
  });

  // A setup runs in the check sandbox, network kept, wherever a check does (ADR 0158); on Linux
  // in a network namespace of its own, away from the host's abstract Unix sockets (ADR 0218).
  it("meets a sandboxed minimum with a repository's setup on macOS and Linux, and refuses it with the checks' line on Windows", () => {
    const files = inputs().files;
    const sandboxed = config(
      { isolation: { minimum: 'sandboxed' } },
      {
        setup: { command: 'npm ci', timeout: '10m' },
      },
    );
    ready(
      inputs({
        platform: 'darwin',
        files: { ...files, config: sandboxed },
        diagnosis: diagnose(macos),
      }),
    );
    ready(inputs({ files: { ...files, config: sandboxed } }));
    // Without a setup, or without the minimum, Linux starts too.
    ready(inputs({ files: { ...files, config: requires('sandboxed') } }));
    ready(
      inputs({
        files: { ...files, config: config({}, { setup: { command: 'npm ci', timeout: '10m' } }) },
      }),
    );
    const problems = refused(
      inputs({
        platform: 'win32',
        files: { ...files, config: sandboxed },
        diagnosis: diagnose(windows),
      }),
    );
    assert.deepStrictEqual(problems, [
      'foedrum.jsonc requires the sandboxed isolation level, and check steps would run at permissions only (native Windows has no sandbox for shell commands) (ADR 0076)',
    ]);
  });

  // A setup also runs before every fresh brewer attempt, so a recipe without a check step runs it
  // too (ADR 0163).
  it("refuses a sandboxed minimum with a repository's setup on native Windows without a check step, and meets it on Linux and macOS", () => {
    const files = inputs().files;
    const stoutOnly = { ...files.brewery, recipes: files.brewery.recipes.slice(0, 1) };
    const sandboxed = config(
      { isolation: { minimum: 'sandboxed' } },
      { setup: { command: 'npm ci', timeout: '10m' } },
    );
    const noChecks = { ...files, config: sandboxed, brewery: stoutOnly };
    ready(inputs({ files: noChecks }));
    assert.deepStrictEqual(
      refused(inputs({ platform: 'win32', files: noChecks, diagnosis: diagnose(windows) })),
      [
        "foedrum.jsonc requires the sandboxed isolation level, and acme/web's setup runs outside a sandbox on native Windows (ADR 0163)",
      ],
    );
    ready(inputs({ platform: 'darwin', files: noChecks, diagnosis: diagnose(macos) }));
  });

  it('says that check steps run unsandboxed on native Windows only', () => {
    assert.equal(ready(inputs()).unsandboxedChecks, false);
    const windowsSetup = ready(inputs({ platform: 'win32', diagnosis: diagnose(windows) }));
    assert.equal(windowsSetup.unsandboxedChecks, true);
    // Linux below the sandboxed level still runs checks in bwrap, or not at all.
    const bare = ready(
      inputs({
        diagnosis: { ...diagnose(linux()), isolation: { level: 'permissions only', why: 'x' } },
      }),
    );
    assert.equal(bare.unsandboxedChecks, false);
  });
});

// Foedrum's defaults map their own model aliases, and a Brewery's models.jsonc merges over them
// (ADR 0153).
describe("serveSetup: Foedrum's default models (ADR 0153)", () => {
  // A default Gauger that names `model`, brewing the one step of a Brewery recipe.
  const gaugerNaming = (model: string) =>
    cellarman
      .replace('"name": "cellarman"', '"name": "gauger"')
      .replace('"model": "quick"', `"model": "${model}"`);
  const gaugerRecipe = recipe.replace('cellarman', 'gauger');
  const defaultModels = (
    fields: Record<string, unknown> = { models: { builder: 'sonnet' } },
  ): BreweryFile => ({ path: 'defaults/models.jsonc', text: JSON.stringify(fields) });

  /** serve's inputs for a Brewery with the default Gauger, `own` as its models.jsonc. */
  const withGauger = (
    own: string | undefined,
    defaults: { model?: string; models?: BreweryFile } = {},
  ) => {
    const { model = 'builder', models: defaultFile = defaultModels() } = defaults;
    return inputs({
      files: {
        ...inputs().files,
        models: own,
        brewery: {
          recipes: [{ path: 'recipes/stout.jsonc', text: gaugerRecipe }],
          brewers: [],
          defaults: {
            brewers: [{ path: 'defaults/brewers/gauger.md', text: gaugerNaming(model) }],
            models: defaultFile,
          },
        },
      },
    });
  };
  const gaugerModel = (setup: ServeSetup): string => {
    const found = setup.brewers.find('stout', 'brew');
    assert.ok(found !== undefined, 'the recipe has no brew step');
    return modelOf(setup.models, found.brewer);
  };

  it('is ready without models.jsonc, and the Gauger resolves the default builder: sonnet', () => {
    const setup = ready(withGauger(undefined));
    assert.equal(gaugerModel(setup), 'sonnet');
    assert.deepStrictEqual(setup.models.models, { builder: 'sonnet' });
  });

  it('lets a Brewery entry replace the default of its alias and keeps every other default alias', () => {
    const setup = ready(
      withGauger(JSON.stringify({ models: { builder: 'claude-sonnet-5-5' } }), {
        models: defaultModels({ models: { builder: 'sonnet', tasting: 'opus' } }),
      }),
    );
    assert.equal(gaugerModel(setup), 'claude-sonnet-5-5');
    assert.deepStrictEqual(setup.models.models, { builder: 'claude-sonnet-5-5', tasting: 'opus' });
  });

  it('keeps the default builder for a Brewery that maps only another alias, and resolves that alias too', () => {
    const own = JSON.stringify({ models: { reviewer: 'claude-opus-5-5' } });
    const setup = ready(withGauger(own));
    assert.equal(gaugerModel(setup), 'sonnet');
    assert.deepStrictEqual(setup.models.models, {
      builder: 'sonnet',
      reviewer: 'claude-opus-5-5',
    });
    // A brewer that names the Brewery's alias resolves it.
    const reviewing = ready(withGauger(own, { model: 'reviewer' }));
    assert.equal(gaugerModel(reviewing), 'claude-opus-5-5');
  });

  it("takes the brewers part from the Brewery's file only", () => {
    const own = JSON.stringify({ models: { reviewer: 'claude-opus-5-5' } });
    const fromDefault = defaultModels({
      models: { builder: 'sonnet', tasting: 'opus' },
      brewers: { gauger: 'tasting' },
    });
    const setup = ready(withGauger(own, { models: fromDefault }));
    assert.deepStrictEqual(setup.models.brewers, {});
    assert.equal(gaugerModel(setup), 'sonnet');
    // The Brewery's own brewers part does apply.
    const swapping = JSON.stringify({
      models: { reviewer: 'claude-opus-5-5' },
      brewers: { gauger: 'reviewer' },
    });
    const swapped = ready(withGauger(swapping, { models: fromDefault }));
    assert.deepStrictEqual(swapped.models.brewers, { gauger: 'reviewer' });
    assert.equal(gaugerModel(swapped), 'claude-opus-5-5');
  });

  it("accepts a Brewery's brewers part that names a default alias, and refuses one that names no alias at all", () => {
    // The Gauger names `deep`, which the Brewery maps; its brewers part swaps in the default builder.
    const swapTo = (alias: string) =>
      JSON.stringify({ models: { deep: 'claude-opus-5-5' }, brewers: { gauger: alias } });
    const setup = ready(withGauger(swapTo('builder'), { model: 'deep' }));
    assert.equal(gaugerModel(setup), 'sonnet');
    const problems = refused(withGauger(swapTo('nope'), { model: 'deep' }));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^models\.jsonc: .*No model has the alias "nope"/);
  });

  it('refuses a brewer whose alias neither the default nor the Brewery maps, by its file', () => {
    const line =
      'defaults/brewers/gauger.md: models.jsonc has no model for the alias "deep" of the brewer "gauger"';
    assert.deepStrictEqual(refused(withGauger(undefined, { model: 'deep' })), [line]);
    const own = JSON.stringify({ models: { reviewer: 'claude-opus-5-5' } });
    assert.deepStrictEqual(refused(withGauger(own, { model: 'deep' })), [line]);
  });

  it('needs no models.jsonc, but refuses one that does not pass the schema or does not read, with its line', () => {
    ready(withGauger(undefined));
    for (const text of ['{ "models": { "Quick": "x" } }', '{']) {
      const problems = refused(withGauger(text));
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0] ?? '', /^models\.jsonc: /);
    }
  });

  it('refuses a default models.jsonc that does not pass, does not read or cannot be read, with a line naming its defaults/ path (ADR 0098)', () => {
    const own = JSON.stringify({ models: { builder: 'claude-sonnet-5-5' } });
    const broken: BreweryFile[] = [
      { path: 'defaults/models.jsonc', text: '{' },
      { path: 'defaults/models.jsonc', text: '{ "models": { "Builder": "sonnet" } }' },
      { path: 'defaults/models.jsonc', unreadable: 'EACCES' },
    ];
    for (const file of broken) {
      // With the Brewery's own file mapping builder, only the default is at fault.
      for (const text of [own, undefined]) {
        const problems = refused(withGauger(text, { models: file }));
        assert.ok(
          problems.some((problem) => problem.startsWith('defaults/models.jsonc: ')),
          problems.join('\n'),
        );
      }
    }
  });

  it('refuses a broken default and a broken Brewery models.jsonc with a line each, at once', () => {
    const problems = refused(
      withGauger('{', { models: { path: 'defaults/models.jsonc', text: '{' } }),
    );
    assert.ok(
      problems.some((problem) => problem.startsWith('defaults/models.jsonc: ')),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((problem) => problem.startsWith('models.jsonc: ')),
      problems.join('\n'),
    );
  });
});

describe('serveSetup: keeping the machine awake (ADR 0195)', () => {
  const keepAwake = (brewery: Record<string, unknown>, machine: Record<string, unknown>) =>
    ready(inputs({ files: { ...inputs().files, config: config(brewery), local: local(machine) } }))
      .keepAwake;

  it('keeps the machine awake by default', () => {
    assert.equal(keepAwake({}, {}), true);
  });

  it('takes keepAwake from foedrum.jsonc, and from .foedrum/local.jsonc before it', () => {
    assert.equal(keepAwake({ keepAwake: false }, {}), false);
    assert.equal(keepAwake({}, { keepAwake: false }), false);
    assert.equal(keepAwake({ keepAwake: false }, { keepAwake: true }), true);
    assert.equal(keepAwake({ keepAwake: true }, { keepAwake: false }), false);
  });
});
