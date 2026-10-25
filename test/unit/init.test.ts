// `foedrum init` (ADR 0199) through a fake terminal, an in-memory clone, a fake GitHub and a fake
// doctor: the questions and their defaults, the files it writes, each passing its schema, a Node
// repository's checks from package.json, an existing file kept unless the user says yes, a second
// run that changes nothing, and doctor's report at the end.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type InitPorts, runInit } from '../../src/cli/init.ts';
import type { CliResult } from '../../src/cli/run.ts';
import type { RepositoryFacts } from '../../src/github/repository-facts.ts';
import { BreweryConfig } from '../../src/schemas/brewery-config.ts';
import { BreweryClaudeSettings } from '../../src/schemas/brewery-settings.ts';
import { Repo } from '../../src/schemas/events.ts';
import { RepositoryAlias } from '../../src/schemas/ids.ts';
import { ModelsConfig } from '../../src/schemas/models.ts';
import { withinCeiling } from '../../src/schemas/primitives.ts';
import { readJsonc } from '../../src/schemas/read.ts';

const node = (scripts: Record<string, string>): string => JSON.stringify({ name: 'web', scripts });

/** acme/web is a Node repository on trunk; acme/api has no package.json. */
const GITHUB: Readonly<Record<string, RepositoryFacts>> = {
  'acme/web': {
    base: 'trunk',
    packageJson: node({ build: 'tsc -b', lint: 'biome check', test: 'node --test' }),
    lockfile: true,
  },
  'acme/api': { base: 'main', packageJson: undefined, lockfile: false },
  'other/web': { base: 'main', packageJson: node({}), lockfile: false },
  // A byte order mark, as Windows editors write one; npm reads the file.
  'bom/web': {
    base: 'main',
    packageJson: `${String.fromCodePoint(0xfeff)}${node({ test: 'node --test' })}`,
    lockfile: false,
  },
  // GitHub sends a file over 1 MB without its content.
  'big/web': { base: 'main', packageJson: '', lockfile: true },
};

interface Clone {
  files: Map<string, string>;
  git?: boolean;
}

interface Run {
  result: CliResult;
  questions: string[];
  lines: string[];
  written: string[];
  read: string[];
}

/** Runs init with `answers` in order; an answer past the last is the end of standard input. */
const init = async (
  answers: readonly string[],
  clone: Clone = { files: new Map() },
  options: { doctor?: { ok: boolean; report: string } } = {},
): Promise<Run> => {
  const queue = [...answers];
  const run: Omit<Run, 'result'> = { questions: [], lines: [], written: [], read: [] };
  const ports: InitPorts = {
    ask: async (question) => {
      run.questions.push(question);
      return queue.shift();
    },
    say: (line) => {
      run.lines.push(line);
    },
    files: {
      exists: (path) => (path === '.git' ? clone.git !== false : clone.files.has(path)),
      read: (path) => clone.files.get(path),
      write: (path, text) => {
        run.written.push(path);
        clone.files.set(path, text);
      },
    },
    login: async () => 'octocat',
    repository: async (repo) => {
      run.read.push(repo);
      const facts = GITHUB[repo];
      if (facts === undefined) throw new Error(`GitHub answered 404 to the repository ${repo}`);
      return facts;
    },
    doctor: async () => options.doctor ?? { ok: true, report: 'Doctor: ready\n' },
  };
  const result = await runInit(ports);
  return { result, ...run };
};

const parsed = <T>(clone: Clone, path: string, schema: Parameters<typeof readJsonc<T>>[1]): T => {
  const text = clone.files.get(path) ?? assert.fail(`${path} was not written`);
  const read = readJsonc(text, schema);
  assert.ok(read.valid, read.valid ? '' : `${path}: ${read.reason}`);
  return read.value;
};

describe('foedrum init (ADR 0199)', () => {
  it("asks the Brewery's name, then the targets, with the login's default", async () => {
    const { questions } = await init(['', '']);
    assert.deepStrictEqual(questions, [
      'Brewery repository (owner/name) [octocat/foedrum-brewery]: ',
      'Target repositories (owner/name, separated by spaces): ',
    ]);
  });

  it('writes the four files, each passing its schema, with the defaults for a Node target', async () => {
    const clone: Clone = { files: new Map() };
    const { result, written, questions } = await init(['', 'acme/web', '', ''], clone);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepStrictEqual(written.toSorted(), [
      '.claude/settings.json',
      '.gitignore',
      'foedrum.jsonc',
      'models.jsonc',
    ]);
    assert.equal(questions[2], 'Alias of acme/web [web]: ');
    const config = parsed(clone, 'foedrum.jsonc', BreweryConfig);
    assert.equal(config.brewery, 'octocat/foedrum-brewery');
    assert.deepStrictEqual(config.users, ['octocat']);
    assert.equal(config.concurrency, 1);
    const web = config.repositories['acme/web'] ?? assert.fail('no acme/web');
    assert.equal(web.alias, 'web');
    assert.deepStrictEqual(web.intake, { labels: ['foedrum:brew'] });
    assert.equal(web.source, 'managed');
    assert.equal(web.base, 'trunk');
    assert.deepStrictEqual(web.setup, { command: 'npm ci', timeout: '10m' });
    assert.deepStrictEqual(parsed(clone, 'models.jsonc', ModelsConfig).models, {});
    assert.deepStrictEqual(parsed(clone, '.claude/settings.json', BreweryClaudeSettings), {
      enabledPlugins: { 'foedrum@foedrum': true },
    });
    assert.deepStrictEqual(clone.files.get('.gitignore'), '.foedrum/\n');
  });

  it("reads a Node repository's checks from its package.json scripts, as tools within the ceiling", async () => {
    const clone: Clone = { files: new Map() };
    const { questions } = await init(['', 'acme/web', '', ''], clone);
    // The checks it read are proposed, and confirmed with one answer (ADR 0023).
    assert.deepStrictEqual(questions.slice(3), ['Use these for acme/web? [Y/n]: ']);
    const config = parsed(clone, 'foedrum.jsonc', BreweryConfig);
    const web = config.repositories['acme/web'] ?? assert.fail('no acme/web');
    assert.deepStrictEqual(web.checks, {
      build: 'npm run build',
      typecheck: null,
      lint: 'npm run lint',
      format: null,
      test: 'npm test',
    });
    // The shapes the default Cellarman runs: lint with --write on a path, one test file (ADR 0163).
    const rules = [
      'Bash(npm run build)',
      'Bash(npm run lint)',
      'Bash(npm run lint -- --write *)',
      'Bash(npm run test)',
      'Bash(node --test *)',
    ];
    assert.deepStrictEqual(web.tools, rules);
    assert.deepStrictEqual(config.permissionCeiling, rules);
    for (const rule of rules) {
      assert.ok(withinCeiling(rule, ['Bash(npm run *)', 'Bash(node --test *)']), rule);
    }
  });

  it('shows what it read of a Node repository before asking to use it', async () => {
    const { lines } = await init(['', 'acme/web', '', ''], { files: new Map() });
    const at = lines.indexOf('Read acme/web: base trunk, checks from package.json');
    assert.deepStrictEqual(lines.slice(at + 1, at + 8), [
      '  build: npm run build',
      '  typecheck: none',
      '  lint: npm run lint',
      '  format: none',
      '  test: npm test',
      '  setup: npm ci',
      '  tools: Bash(npm run build), Bash(npm run lint), Bash(npm run lint -- --write *), Bash(npm run test), Bash(node --test *)',
    ]);
  });

  it('asks for each check, with no tools or setup, when the user does not use what it read', async () => {
    const clone: Clone = { files: new Map() };
    const { questions } = await init(
      ['', 'acme/web', '', 'n', 'make', '', '', '', 'make test'],
      clone,
    );
    assert.equal(questions[4], 'build check of acme/web (a command, empty for none): ');
    const config = parsed(clone, 'foedrum.jsonc', BreweryConfig);
    const web = config.repositories['acme/web'] ?? assert.fail('no acme/web');
    assert.deepStrictEqual(web.checks, {
      build: 'make',
      typecheck: null,
      lint: null,
      format: null,
      test: 'make test',
    });
    assert.equal(web.setup, undefined);
    assert.deepStrictEqual(web.tools, []);
    assert.deepStrictEqual(config.permissionCeiling, []);
  });

  it('reads a package.json that starts with a byte order mark', async () => {
    const clone: Clone = { files: new Map() };
    const { lines } = await init(['', 'bom/web', '', ''], clone);
    assert.ok(
      lines.includes('Read bom/web: base main, checks from package.json'),
      lines.join('\n'),
    );
    const config = parsed(clone, 'foedrum.jsonc', BreweryConfig);
    assert.equal(config.repositories['bom/web']?.checks.test, 'npm test');
  });

  it('says a package.json it could not read is there, and asks for the checks', async () => {
    const clone: Clone = { files: new Map() };
    const { lines, questions } = await init(['', 'big/web', '', '', '', '', '', ''], clone);
    assert.ok(
      lines.includes('Read big/web: base main, a package.json it could not read'),
      lines.join('\n'),
    );
    assert.equal(questions[3], 'build check of big/web (a command, empty for none): ');
  });

  it('adds the line to a .gitignore with the line ending it has', async () => {
    for (const [was, now] of [
      ['node_modules/\r\n', 'node_modules/\r\n.foedrum/\r\n'],
      ['node_modules/\r\ndist/', 'node_modules/\r\ndist/\r\n.foedrum/\r\n'],
    ] as const) {
      const clone: Clone = { files: new Map([['.gitignore', was]]) };
      await init(['', '', 'y'], clone);
      assert.equal(clone.files.get('.gitignore'), now, JSON.stringify(was));
    }
  });

  it('asks for each check of a repository without a package.json, empty for none', async () => {
    const clone: Clone = { files: new Map() };
    const { questions } = await init(
      ['', 'acme/api', '', 'make', '', 'make lint', '', 'make test'],
      clone,
    );
    assert.deepStrictEqual(questions.slice(2), [
      'Alias of acme/api [api]: ',
      'build check of acme/api (a command, empty for none): ',
      'typecheck check of acme/api (a command, empty for none): ',
      'lint check of acme/api (a command, empty for none): ',
      'format check of acme/api (a command, empty for none): ',
      'test check of acme/api (a command, empty for none): ',
    ]);
    const config = parsed(clone, 'foedrum.jsonc', BreweryConfig);
    const api = config.repositories['acme/api'] ?? assert.fail('no acme/api');
    assert.deepStrictEqual(api.checks, {
      build: 'make',
      typecheck: null,
      lint: 'make lint',
      format: null,
      test: 'make test',
    });
    assert.equal(api.setup, undefined);
    assert.deepStrictEqual(api.tools, []);
  });

  it("asks again, with the schema's message, for an answer that does not pass", async () => {
    const clone: Clone = { files: new Map() };
    const { questions, lines } = await init(
      ['not a repo', 'acme/brewery', 'acme/web', 'Web!', '', ''],
      clone,
    );
    assert.equal(questions[0], questions[1]);
    assert.equal(questions[3], questions[4]);
    const messageOf = (result: { error?: { issues: { message: string }[] } }) =>
      `  ${result.error?.issues[0]?.message}`;
    for (const message of [
      messageOf(Repo.safeParse('not a repo')),
      messageOf(RepositoryAlias.safeParse('Web!')),
    ]) {
      assert.ok(lines.includes(message), `${message} in ${lines.join('\n')}`);
    }
    assert.equal(parsed(clone, 'foedrum.jsonc', BreweryConfig).brewery, 'acme/brewery');
  });

  it('keeps an existing file unless the user says yes, after listing what would change', async () => {
    const kept: Clone = { files: new Map([['.gitignore', 'node_modules/\n']]) };
    const no = await init(['', '', 'n'], kept);
    assert.ok(no.questions.includes('Change .gitignore? [y/N]: '), no.questions.join('\n'));
    assert.ok(no.lines.includes('.gitignore would change:'), no.lines.join('\n'));
    assert.ok(no.lines.includes('  + .foedrum/'), no.lines.join('\n'));
    assert.ok(!no.written.includes('.gitignore'));
    assert.equal(kept.files.get('.gitignore'), 'node_modules/\n');

    const changed: Clone = { files: new Map([['.gitignore', 'node_modules/\n']]) };
    const yes = await init(['', '', 'y'], changed);
    assert.ok(yes.written.includes('.gitignore'));
    assert.equal(changed.files.get('.gitignore'), 'node_modules/\n.foedrum/\n');
  });

  it("merges the plugin into the settings there, keeping Claude Code's other keys", async () => {
    const settings = JSON.stringify({ model: 'opus', enabledPlugins: { other: true } });
    const clone: Clone = { files: new Map([['.claude/settings.json', settings]]) };
    const { lines } = await init(['', '', 'y'], clone);
    assert.ok(lines.includes('  enabledPlugins.foedrum@foedrum (added)'), lines.join('\n'));
    assert.deepStrictEqual(parsed(clone, '.claude/settings.json', BreweryClaudeSettings), {
      model: 'opus',
      enabledPlugins: { other: true, 'foedrum@foedrum': true },
    });
  });

  it('changes nothing on a second run with the same answers, and asks nothing about the files', async () => {
    const clone: Clone = { files: new Map() };
    await init(['', 'acme/web', '', ''], clone);
    const before = new Map(clone.files);
    const again = await init(['', ''], clone);
    // The defaults are the first run's: the Brewery and its targets.
    assert.deepStrictEqual(again.questions, [
      'Brewery repository (owner/name) [octocat/foedrum-brewery]: ',
      'Target repositories (owner/name, separated by spaces) [acme/web]: ',
    ]);
    assert.deepStrictEqual(again.written, []);
    assert.deepStrictEqual(again.read, []);
    assert.deepStrictEqual(clone.files, before);
    for (const file of ['foedrum.jsonc', '.gitignore', '.claude/settings.json']) {
      assert.ok(again.lines.includes(`${file} is up to date`), again.lines.join('\n'));
    }
    // init writes no key of models.jsonc, so it keeps the one there, whatever it holds.
    assert.ok(again.lines.includes('models.jsonc is kept as it is'), again.lines.join('\n'));
    assert.ok(again.lines.includes('Written: none'), again.lines.join('\n'));
  });

  it('lists what another answer would change on a second run, and writes nothing unasked', async () => {
    const clone: Clone = { files: new Map() };
    await init(['', 'acme/web', '', ''], clone);
    const before = clone.files.get('foedrum.jsonc');
    const again = await init(['', 'acme/web acme/api', '', '', '', '', '', '', 'n'], clone);
    assert.ok(again.lines.includes('foedrum.jsonc would change:'), again.lines.join('\n'));
    assert.ok(again.lines.includes('  repositories.acme/api (added)'), again.lines.join('\n'));
    assert.ok(
      again.questions.includes('Change foedrum.jsonc (its comments are not kept)? [y/N]: '),
      again.questions.join('\n'),
    );
    assert.deepStrictEqual(again.written, []);
    assert.equal(clone.files.get('foedrum.jsonc'), before);
  });

  it('refuses a foedrum.jsonc that does not pass its schema, before any question', async () => {
    const clone: Clone = { files: new Map([['foedrum.jsonc', '{ "colour": "amber" }']]) };
    const { result, questions, written } = await init([], clone);
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /^foedrum init: the foedrum\.jsonc here does not pass its schema: /,
    );
    assert.deepStrictEqual(questions, []);
    assert.deepStrictEqual(written, []);
  });

  it('lets a new repository take the alias of one it no longer lists', async () => {
    const clone: Clone = { files: new Map() };
    await init(['', 'acme/web', '', ''], clone);
    const again = await init(['', 'other/web', '', '', 'y'], clone);
    assert.ok(again.questions.includes('Alias of other/web [web]: '), again.questions.join('\n'));
    const config = parsed(clone, 'foedrum.jsonc', BreweryConfig);
    assert.deepStrictEqual(Object.keys(config.repositories), ['other/web']);
  });

  it("runs doctor at the end, shows its report, ends with its exit code and the plugin's commands", async () => {
    const report = 'Doctor: claude is missing\n';
    const { result, lines } = await init(
      ['', ''],
      { files: new Map() },
      {
        doctor: { ok: false, report },
      },
    );
    assert.equal(result.exitCode, 1);
    const shown = lines.join('\n');
    assert.ok(shown.includes(report.trimEnd()), shown);
    // What was written comes before doctor's report, so a failing doctor never reads as nothing.
    const written = lines.indexOf(
      'Written: foedrum.jsonc, models.jsonc, .gitignore, .claude/settings.json',
    );
    assert.ok(written >= 0 && written < lines.indexOf(report.trimEnd()), shown);
    const at = lines.indexOf('claude plugin marketplace add EdwinBekaert/foedrum');
    assert.ok(at > 0, shown);
    assert.equal(lines[at + 1], 'claude plugin install foedrum@foedrum --scope project');
  });

  it('finds .foedrum ignored in each form git reads, but not in a near miss', async () => {
    for (const was of [
      '.foedrum\n',
      '/.foedrum\n',
      '.foedrum/\n',
      '/.foedrum/\n',
      'x\r\n.foedrum/\r\n',
    ]) {
      const clone: Clone = { files: new Map([['.gitignore', was]]) };
      const { lines, written } = await init(['', ''], clone);
      assert.ok(lines.includes('.gitignore is up to date'), JSON.stringify(was));
      assert.ok(!written.includes('.gitignore'), JSON.stringify(was));
    }
    const near: Clone = { files: new Map([['.gitignore', '.foedrumx\n']]) };
    const { lines } = await init(['', '', 'y'], near);
    assert.ok(lines.includes('.gitignore would change:'), lines.join('\n'));
    assert.equal(near.files.get('.gitignore'), '.foedrumx\n.foedrum/\n');
  });

  it('ends a last line without a line break before adding its own', async () => {
    const clone: Clone = { files: new Map([['.gitignore', 'node_modules/']]) };
    await init(['', '', 'y'], clone);
    assert.equal(clone.files.get('.gitignore'), 'node_modules/\n.foedrum/\n');
  });

  it('stops with one line when standard input ends at a file question, writing no file after it', async () => {
    const clone: Clone = { files: new Map([['.gitignore', 'node_modules/\n']]) };
    const { result, written } = await init(['', ''], clone);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum init: no answer to "Change \.gitignore\?"/);
    assert.deepStrictEqual(written, ['foedrum.jsonc', 'models.jsonc']);
  });

  it('asks the targets again for a repository named twice, or one GitHub cannot find', async () => {
    const { lines, questions } = await init(['', 'acme/api ACME/api', 'gone/repo', ''], {
      files: new Map(),
    });
    assert.equal(questions[1], questions[2]);
    assert.equal(questions[2], questions[3]);
    assert.ok(lines.includes('  A repository is named twice'), lines.join('\n'));
    assert.ok(
      lines.includes('  GitHub answered 404 to the repository gone/repo'),
      lines.join('\n'),
    );
  });

  it('refuses the alias of a repository it keeps for a new one, and writes no setup without a lockfile', async () => {
    const clone: Clone = { files: new Map() };
    await init(['', 'acme/web', '', ''], clone);
    const again = await init(['', 'acme/web other/web', 'web', 'site', '', 'y'], clone);
    assert.ok(again.questions.includes('Alias of other/web: '), again.questions.join('\n'));
    assert.ok(again.lines.includes('  The alias web is taken'), again.lines.join('\n'));
    const config = parsed(clone, 'foedrum.jsonc', BreweryConfig);
    assert.equal(config.repositories['other/web']?.alias, 'site');
    assert.equal(config.repositories['other/web']?.setup, undefined);
  });

  it('names a settings file that does not read, and asks before replacing it', async () => {
    const clone: Clone = { files: new Map([['.claude/settings.json', '{ not json']]) };
    const { lines, questions } = await init(['', '', 'n'], clone);
    const at = lines.indexOf('.claude/settings.json would change:');
    assert.ok(at >= 0, lines.join('\n'));
    assert.match(lines[at + 1] ?? '', /^ {2}all of it: /);
    assert.ok(questions.includes('Change .claude/settings.json? [y/N]: '), questions.join('\n'));
    assert.equal(clone.files.get('.claude/settings.json'), '{ not json');
  });

  it('refuses a folder that is not a clone, before any question', async () => {
    const { result, questions, written } = await init([], { files: new Map(), git: false });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum init: .*clone/);
    assert.deepStrictEqual(questions, []);
    assert.deepStrictEqual(written, []);
  });

  it('stops with one line, writing nothing, when standard input ends before the answers', async () => {
    const clone: Clone = { files: new Map() };
    const { result, written } = await init([''], clone);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum init: no answer to /);
    assert.deepStrictEqual(written, []);
  });
});
