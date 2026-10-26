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
  /** What init did on GitHub, with git and doctor, and each file it wrote, in order. */
  events: string[];
  /** Each git call: the folder from the working directory, and its arguments. */
  git: { folder: string; args: readonly string[] }[];
}

interface Options {
  doctor?: { ok: boolean; report: string };
  /** The repositories GitHub has; default none. */
  repositories?: readonly string[];
  /** The target repositories without the intake label; default none. */
  unlabelled?: readonly string[];
  /** Creating a label fails with this. */
  labelFails?: string;
  /** Reading whether a target repository has the label fails with this. */
  labelReadFails?: string;
  /** Creating the Brewery's repository fails with this. */
  createFails?: string;
  /** What `git status` prints; default nothing to commit. */
  status?: string;
  /** What `git log` prints of the commits no remote has; default none. */
  unpushed?: string;
  /** git calls that fail, by their command, with what git says. */
  gitFails?: Readonly<Record<string, string>>;
  /** The exit code of a git call that fails, by its command; default 1. */
  gitCodes?: Readonly<Record<string, number>>;
}

/** Runs init with `answers` in order; an answer past the last is the end of standard input. */
const init = async (
  answers: readonly string[],
  clone: Clone = { files: new Map() },
  options: Options = {},
): Promise<Run> => {
  const queue = [...answers];
  const run: Omit<Run, 'result'> = {
    questions: [],
    lines: [],
    written: [],
    read: [],
    events: [],
    git: [],
  };
  const ports: InitPorts = {
    ask: async (question) => {
      run.questions.push(question);
      return queue.shift();
    },
    say: (line) => {
      run.lines.push(line);
    },
    files: {
      exists: (path) =>
        path === '.git'
          ? clone.git !== false
          : [...clone.files.keys()].some((file) => file === path || file.startsWith(`${path}/`)),
      read: (path) => clone.files.get(path),
      write: (path, text) => {
        run.written.push(path);
        run.events.push(`write ${path}`);
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
    github: {
      exists: async (repo) => {
        run.events.push(`exists ${repo}`);
        return (options.repositories ?? []).includes(repo);
      },
      create: async (repo, login, isPrivate) => {
        run.events.push(`create ${repo} ${login} ${isPrivate ? 'private' : 'public'}`);
        if (options.createFails !== undefined) throw new Error(options.createFails);
      },
      hasLabel: async (repo, label) => {
        run.events.push(`has ${repo} ${label}`);
        if (options.labelReadFails !== undefined) throw new Error(options.labelReadFails);
        return !(options.unlabelled ?? []).includes(repo);
      },
      createLabel: async (repo, label, description) => {
        run.events.push(`label ${repo} ${label} ${description}`);
        if (options.labelFails !== undefined) throw new Error(options.labelFails);
      },
    },
    git: async (folder, args) => {
      run.git.push({ folder, args });
      run.events.push(`git ${args[0]}`);
      const fails = options.gitFails?.[args[0] ?? ''];
      if (fails !== undefined) {
        return { code: options.gitCodes?.[args[0] ?? ''] ?? 1, stdout: '', stderr: `${fails}\n` };
      }
      const printed: Readonly<Record<string, string | undefined>> = {
        status: options.status,
        log: options.unpushed,
      };
      return { code: 0, stdout: printed[args[0] ?? ''] ?? '', stderr: '' };
    },
    doctor: async (folder) => {
      run.events.push(`doctor ${folder}`);
      return options.doctor ?? { ok: true, report: 'Doctor: ready\n' };
    },
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
    assert.ok(again.lines.includes('  repositories.acme/web (removed)'), again.lines.join('\n'));
  });

  it('lists a changed value by its path', async () => {
    const clone: Clone = { files: new Map() };
    await init(['', ''], clone);
    const again = await init(['acme/brewery', '', 'n'], clone);
    assert.ok(again.lines.includes('  brewery'), again.lines.join('\n'));
  });

  it('keeps the keys of a foedrum.jsonc it does not ask about', async () => {
    const was = {
      brewery: 'acme/brewery',
      users: ['octocat', 'hubot'],
      pollEvery: '5m',
      permissionCeiling: ['Bash(make *)'],
      repositories: {},
    };
    const clone: Clone = { files: new Map([['foedrum.jsonc', JSON.stringify(was)]]) };
    await init(['', 'acme/api', '', '', '', '', '', '', 'y'], clone);
    const config = parsed(clone, 'foedrum.jsonc', BreweryConfig);
    assert.deepStrictEqual(config.users, ['octocat', 'hubot']);
    assert.equal(config.pollEvery, '5m');
    assert.deepStrictEqual(config.permissionCeiling, ['Bash(make *)']);
    assert.ok(config.repositories['acme/api'] !== undefined);
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

  it('stops with one line, writing nothing, when standard input ends before the answers', async () => {
    const clone: Clone = { files: new Map() };
    const { result, written } = await init([''], clone);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum init: no answer to /);
    assert.deepStrictEqual(written, []);
  });
});

const LABEL_DESCRIPTION = 'Foedrum brews an issue with this label into a pull request';
const FILES = ['foedrum.jsonc', 'models.jsonc', '.gitignore', '.claude/settings.json'];
/** What `git status --porcelain -z` prints for the four files, new. */
const ALL_NEW = `${FILES.map((file) => `?? ${file}`).join('\0')}\0`;
const outside = (): Clone => ({ files: new Map(), git: false });

describe('foedrum init outside a clone, the labels and the push (ADR 0207)', () => {
  it('creates a private repository with the default name after the questions, clones it and writes the files there', async () => {
    const clone = outside();
    const { result, questions, events, git, lines } = await init(['', '', ''], clone);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepStrictEqual(questions, [
      'Brewery repository (owner/name) [octocat/foedrum-brewery]: ',
      'Private or public [private]: ',
      'Target repositories (owner/name, separated by spaces): ',
    ]);
    assert.deepStrictEqual(events.slice(0, 3), [
      'exists octocat/foedrum-brewery',
      'create octocat/foedrum-brewery octocat private',
      'git clone',
    ]);
    assert.deepStrictEqual(git[0], {
      folder: '',
      args: ['clone', '--', 'https://github.com/octocat/foedrum-brewery.git', 'foedrum-brewery'],
    });
    // The files go into the clone, and doctor runs there.
    for (const file of FILES) assert.ok(clone.files.has(`foedrum-brewery/${file}`), file);
    assert.ok(events.includes('doctor foedrum-brewery'), events.join('\n'));
    assert.ok(lines.includes('The Brewery is in the folder foedrum-brewery'), lines.join('\n'));
    const config = parsed(clone, 'foedrum-brewery/foedrum.jsonc', BreweryConfig);
    assert.equal(config.brewery, 'octocat/foedrum-brewery');
  });

  it('creates a public repository when asked, after asking again for an answer that is neither', async () => {
    const { events, lines } = await init(['', 'secret', 'public', ''], outside());
    assert.ok(lines.includes('  Answer private or public'), lines.join('\n'));
    assert.ok(events.includes('create octocat/foedrum-brewery octocat public'), events.join('\n'));
  });

  it('creates the repository of an organization, and clones it into a folder of its name', async () => {
    const clone = outside();
    const { events, git } = await init(['acme/brewery', '', ''], clone);
    assert.ok(events.includes('create acme/brewery octocat private'), events.join('\n'));
    assert.deepStrictEqual(git[0]?.args, [
      'clone',
      '--',
      'https://github.com/acme/brewery.git',
      'brewery',
    ]);
    assert.ok(clone.files.has('brewery/foedrum.jsonc'));
  });

  it('refuses a name GitHub has with one line, creating and asking nothing more', async () => {
    const { result, questions, events, written } = await init(['', '', ''], outside(), {
      repositories: ['octocat/foedrum-brewery'],
    });
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /^foedrum init: octocat\/foedrum-brewery is on GitHub already; .*clone/,
    );
    assert.equal(result.stderr.split('\n').filter(Boolean).length, 1);
    assert.equal(questions.length, 1);
    assert.deepStrictEqual(events, ['exists octocat/foedrum-brewery']);
    assert.deepStrictEqual(written, []);
  });

  it("refuses a folder of the repository's name that is there, before creating anything", async () => {
    const clone: Clone = { files: new Map([['foedrum-brewery/notes.txt', 'x']]), git: false };
    const { result, events } = await init(['', '', ''], clone);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum init: the folder foedrum-brewery is there already/);
    assert.ok(!events.some((event) => event.startsWith('create')), events.join('\n'));
  });

  it('creates nothing when standard input ends before the last question', async () => {
    const { result, events } = await init(['', ''], outside());
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum init: no answer to "Target repositories/);
    assert.ok(!events.some((event) => /^(create|git)/.test(event)), events.join('\n'));
  });

  it("stops with git's line when the clone fails, writing nothing", async () => {
    const { result, written } = await init(['', '', ''], outside(), {
      gitFails: { clone: 'fatal: repository not found' },
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /git clone failed: fatal: repository not found/);
    assert.deepStrictEqual(written, []);
  });

  it('creates and clones nothing inside a clone, also for a name GitHub has, and asks nothing to push when nothing changed', async () => {
    const { result, questions, events, lines } = await init(['', ''], undefined, {
      repositories: ['octocat/foedrum-brewery'],
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(!questions.some((question) => question.startsWith('Private')), questions.join('\n'));
    assert.ok(!events.some((event) => /^(exists|create|git clone)/.test(event)), events.join('\n'));
    assert.ok(events.includes('doctor '), events.join('\n'));
    assert.ok(lines.includes('Nothing to commit'), lines.join('\n'));
    assert.ok(!questions.some((question) => question.startsWith('Commit')), questions.join('\n'));
  });

  it('creates the intake label after a yes, with its description', async () => {
    const { questions, events } = await init(['', 'acme/web', '', '', ''], undefined, {
      unlabelled: ['acme/web'],
    });
    assert.ok(
      questions.includes('Create the label foedrum:brew in acme/web? [Y/n]: '),
      questions.join('\n'),
    );
    assert.ok(
      events.includes(`label acme/web foedrum:brew ${LABEL_DESCRIPTION}`),
      events.join('\n'),
    );
  });

  it('prints the gh command after a no, creating no label', async () => {
    const { lines, events } = await init(['', 'acme/web', '', '', 'n'], undefined, {
      unlabelled: ['acme/web'],
    });
    assert.ok(!events.some((event) => event.startsWith('label')), events.join('\n'));
    assert.ok(
      lines.includes(
        `gh label create foedrum:brew --repo acme/web --description "${LABEL_DESCRIPTION}" --color ededed`,
      ),
      lines.join('\n'),
    );
  });

  it('leaves a label that is there alone, without asking', async () => {
    const { questions, events, lines } = await init(['', 'acme/web', '', '']);
    assert.ok(events.includes('has acme/web foedrum:brew'), events.join('\n'));
    assert.ok(!events.some((event) => event.startsWith('label')), events.join('\n'));
    assert.ok(!questions.some((question) => question.startsWith('Create')), questions.join('\n'));
    assert.ok(lines.includes('acme/web has the label foedrum:brew'), lines.join('\n'));
  });

  it('names a label it cannot create, with the gh command, and goes on', async () => {
    const { result, lines } = await init(['', 'acme/web', '', '', ''], undefined, {
      unlabelled: ['acme/web'],
      labelFails: 'GitHub answered 403 to the label: Must have admin rights',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const at = lines.findIndex((line) => line.includes('Must have admin rights'));
    assert.ok(at >= 0, lines.join('\n'));
    assert.match(lines[at + 1] ?? '', /^gh label create foedrum:brew --repo acme\/web /);
  });

  it('lists what it will commit, then commits and pushes it after a yes, before doctor', async () => {
    const { questions, git, events, lines } = await init(['', '', ''], undefined, {
      status: ALL_NEW,
    });
    for (const file of FILES) assert.ok(lines.includes(`  ${file}`), lines.join('\n'));
    assert.ok(questions.includes('Commit and push these? [Y/n]: '), questions.join('\n'));
    // The order of the three calls; what the commit takes has a test of its own.
    const after = git.filter(({ args }) => ['add', 'commit', 'push'].includes(args[0] ?? ''));
    assert.deepStrictEqual(
      after.map(({ folder, args }) => [folder, args[0]]),
      [
        ['', 'add'],
        ['', 'commit'],
        ['', 'push'],
      ],
    );
    assert.deepStrictEqual(after[0]?.args, ['add', '--', ...FILES]);
    assert.deepStrictEqual(after[2]?.args, ['push', '-u', 'origin', 'HEAD']);
    assert.ok(events.indexOf('git push') < events.indexOf('doctor '), events.join('\n'));
  });

  it('commits and pushes in the new clone', async () => {
    const { git } = await init(['', '', '', ''], outside(), { status: ALL_NEW });
    const push = git.find(({ args }) => args[0] === 'push');
    assert.equal(push?.folder, 'foedrum-brewery');
  });

  it('pushes nothing after a no, keeps the files and says how to push them', async () => {
    const clone: Clone = { files: new Map() };
    const { git, lines } = await init(['', '', 'n'], clone, { status: ALL_NEW });
    assert.ok(
      !git.some(({ args }) => ['add', 'commit', 'push'].includes(args[0] ?? '')),
      JSON.stringify(git),
    );
    assert.ok(clone.files.has('foedrum.jsonc'));
    for (const command of [`git add -- ${FILES.join(' ')}`, 'git push -u origin HEAD']) {
      assert.ok(lines.includes(command), lines.join('\n'));
    }
    // What the commit command takes has a test of its own.
    assert.ok(
      lines.some((line) => line.startsWith('git commit -m "Set up the Brewery with foedrum init"')),
      lines.join('\n'),
    );
  });

  it("names a push that fails with git's line and the commands, and ends in 1 after doctor", async () => {
    const { result, lines, events } = await init(['', '', ''], undefined, {
      status: ALL_NEW,
      gitFails: { push: 'remote: Permission denied' },
    });
    assert.equal(result.exitCode, 1);
    assert.ok(lines.includes('git push failed: remote: Permission denied'), lines.join('\n'));
    assert.ok(lines.includes('git push -u origin HEAD'), lines.join('\n'));
    assert.ok(events.includes('doctor '), events.join('\n'));
  });

  it('passes no token to git: a plain https URL, and arguments without a credential', async () => {
    const { git } = await init(['', '', '', ''], outside(), { status: ALL_NEW });
    for (const command of ['clone', 'add', 'commit', 'push']) {
      assert.ok(
        git.some(({ args }) => args[0] === command),
        command,
      );
    }
    for (const { args } of git) {
      for (const arg of args) assert.doesNotMatch(arg, /@|token|gh[pousr]_/i, arg);
    }
  });
  it("stops with GitHub's line when the repository cannot be created, cloning and writing nothing", async () => {
    const { result, events, written } = await init(['', '', ''], outside(), {
      createFails: 'GitHub answered 422 to creating the repository: name already exists',
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum init: GitHub answered 422 to creating the repository/);
    assert.ok(!events.includes('git clone'), events.join('\n'));
    assert.deepStrictEqual(written, []);
  });

  it('lists and adds only the files git names as new or changed', async () => {
    const { lines, git } = await init(['', '', ''], undefined, { status: ' M foedrum.jsonc\0' });
    assert.ok(lines.includes('  foedrum.jsonc'), lines.join('\n'));
    assert.ok(!lines.includes('  models.jsonc'), lines.join('\n'));
    assert.deepStrictEqual(git.find(({ args }) => args[0] === 'add')?.args, [
      'add',
      '--',
      'foedrum.jsonc',
    ]);
  });

  it('stops at an add that fails, with the commands, committing and pushing nothing', async () => {
    const { result, lines, git } = await init(['', '', ''], undefined, {
      status: ALL_NEW,
      gitFails: { add: 'fatal: index.lock exists' },
    });
    assert.equal(result.exitCode, 1);
    assert.ok(lines.includes('git add failed: fatal: index.lock exists'), lines.join('\n'));
    assert.ok(!git.some(({ args }) => ['commit', 'push'].includes(args[0] ?? '')));
    assert.ok(lines.includes('git push -u origin HEAD'), lines.join('\n'));
  });

  it('names a status that fails, with the commands, and ends in 1', async () => {
    const { result, lines, questions } = await init(['', ''], undefined, {
      gitFails: { status: 'fatal: not a git repository' },
    });
    assert.equal(result.exitCode, 1);
    assert.ok(lines.includes('git status failed: fatal: not a git repository'), lines.join('\n'));
    assert.ok(lines.includes('git push -u origin HEAD'), lines.join('\n'));
    assert.ok(!questions.some((question) => question.startsWith('Commit')), questions.join('\n'));
  });

  it('names a label it cannot read, with the gh command, without asking', async () => {
    const { result, lines, questions } = await init(['', 'acme/web', '', ''], undefined, {
      labelReadFails: 'GitHub answered 500 to the label foedrum:brew of acme/web',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const at = lines.indexOf('GitHub answered 500 to the label foedrum:brew of acme/web');
    assert.ok(at >= 0, lines.join('\n'));
    assert.match(lines[at + 1] ?? '', /^gh label create foedrum:brew --repo acme\/web /);
    assert.ok(!questions.some((question) => question.startsWith('Create')), questions.join('\n'));
  });

  it('stops with one line when standard input ends at the label question', async () => {
    const { result, events } = await init(['', 'acme/web', '', ''], undefined, {
      unlabelled: ['acme/web'],
    });
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /^foedrum init: no answer to "Create the label foedrum:brew in acme\/web\?"/,
    );
    // Inside a clone init created nothing, so the line names nothing.
    assert.doesNotMatch(result.stderr, /created and cloned/);
    assert.ok(!events.some((event) => event.startsWith('git status')), events.join('\n'));
  });
  it('commits only the files it lists, never what else is staged, and prints the same command', async () => {
    const yes = await init(['', '', ''], undefined, { status: ' M foedrum.jsonc\0' });
    assert.deepStrictEqual(yes.git.find(({ args }) => args[0] === 'commit')?.args, [
      'commit',
      '-m',
      'Set up the Brewery with foedrum init',
      '--',
      'foedrum.jsonc',
    ]);
    const no = await init(['', '', 'n'], undefined, { status: ' M foedrum.jsonc\0' });
    assert.ok(
      no.lines.includes('git commit -m "Set up the Brewery with foedrum init" -- foedrum.jsonc'),
      no.lines.join('\n'),
    );
  });

  it('lists the commits GitHub does not have yet, which the push sends too, before asking', async () => {
    const { lines, git } = await init(['', '', ''], undefined, {
      status: ALL_NEW,
      unpushed: 'abc1234 Local work\ndef5678 More local work\n',
    });
    assert.deepStrictEqual(git.find(({ args }) => args[0] === 'log')?.args, [
      'log',
      '--format=%h %s',
      'HEAD',
      '--not',
      '--remotes',
    ]);
    const at = lines.indexOf('Also pushed, not on GitHub yet:');
    assert.ok(at > lines.indexOf('  .claude/settings.json'), lines.join('\n'));
    assert.deepStrictEqual(lines.slice(at + 1, at + 3), [
      '  abc1234 Local work',
      '  def5678 More local work',
    ]);
  });

  it('asks git for no commits on a branch that has none yet', async () => {
    const { git, lines } = await init(['', '', ''], undefined, {
      status: ALL_NEW,
      gitFails: { 'rev-parse': '' },
    });
    assert.deepStrictEqual(git.find(({ args }) => args[0] === 'rev-parse')?.args, [
      'rev-parse',
      '-q',
      '--verify',
      'HEAD',
    ]);
    assert.ok(!git.some(({ args }) => args[0] === 'log'));
    assert.ok(!lines.includes('Also pushed, not on GitHub yet:'), lines.join('\n'));
    assert.ok(git.some(({ args }) => args[0] === 'push'));
  });

  it('pushes nothing when it cannot tell which commits GitHub lacks', async () => {
    const { result, lines, git, questions } = await init(['', '', ''], undefined, {
      status: ALL_NEW,
      gitFails: { log: 'fatal: bad object' },
    });
    assert.equal(result.exitCode, 1);
    assert.ok(lines.includes('git log failed: fatal: bad object'), lines.join('\n'));
    assert.ok(!git.some(({ args }) => args[0] === 'push'));
    assert.ok(!questions.some((question) => question.startsWith('Commit')), questions.join('\n'));
  });

  it('refuses a name Windows cannot have as a folder before asking GitHub, but not a near miss', async () => {
    for (const name of [
      'octocat/NUL',
      'octocat/con.d',
      'octocat/com1',
      'octocat/prn',
      'octocat/AUX',
      'octocat/lpt9',
      'octocat/brewery.',
    ]) {
      const { result, events } = await init([name, '', ''], outside());
      assert.equal(result.exitCode, 1, name);
      const folder = name.split('/')[1] ?? '';
      assert.equal(
        result.stderr,
        `foedrum init: ${folder} cannot be a folder on Windows; choose another name\n`,
      );
      assert.deepStrictEqual(events, [], name);
    }
    for (const near of ['console', 'com0', 'lpt']) {
      const { events } = await init([`octocat/${near}`, '', ''], outside());
      assert.ok(events.includes(`create octocat/${near} octocat private`), events.join('\n'));
    }
  });

  it('names the folder and the repository it created when input ends after them', async () => {
    const { result } = await init(['', '', 'acme/web', '', ''], outside(), {
      unlabelled: ['acme/web'],
    });
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /^foedrum init: no answer to "Create the label foedrum:brew in acme\/web\?"; .*octocat\/foedrum-brewery is created and cloned into the folder foedrum-brewery/,
    );
  });
  it('pushes nothing when git cannot tell whether the branch has a commit', async () => {
    const { result, lines, git, questions } = await init(['', '', ''], undefined, {
      status: ALL_NEW,
      gitFails: { 'rev-parse': 'fatal: not a git repository' },
      gitCodes: { 'rev-parse': 128 },
    });
    assert.equal(result.exitCode, 1);
    assert.ok(
      lines.includes('git rev-parse failed: fatal: not a git repository'),
      lines.join('\n'),
    );
    assert.ok(!git.some(({ args }) => ['log', 'push'].includes(args[0] ?? '')));
    assert.ok(!questions.some((question) => question.startsWith('Commit')), questions.join('\n'));
  });
});
