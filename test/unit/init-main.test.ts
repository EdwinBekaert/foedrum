// `foedrum init` on a clone (init-main.ts), the wiring main.ts runs, with a fake process runner, a
// fake PATH and answers piped in: the files land in the clone, GitHub is read through gh, and
// doctor runs there (ADR 0021, ADR 0199).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { initFromCheckout } from '../../src/cli/init-main.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { BreweryConfig } from '../../src/schemas/brewery-config.ts';
import { readJsonc } from '../../src/schemas/read.ts';
import { fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const base64 = (text: string) => Buffer.from(text).toString('base64');

/** A Brewery's foedrum.jsonc, which makes the folder it is at the top of a Brewery (ADR 0393). */
const BREWERY = JSON.stringify({ brewery: 'octocat/foedrum-brewery', repositories: {} });

/** What git says from a folder at the top of a repository, for `rev-parse --show-cdup`. */
const atTop = (args: readonly string[]) =>
  args[1] === '--show-cdup' ? { exitCode: 0, stdout: '\n', stderr: '', output: '\n' } : undefined;

describe('initFromCheckout', () => {
  const dir = makeTempDir('init-main');
  after(() => dir.remove());
  mkdirSync(join(dir.path, '.git'));
  writeFileSync(join(dir.path, 'foedrum.jsonc'), BREWERY);

  it('asks on the terminal, reads GitHub through gh, writes the files in the clone and runs doctor', async () => {
    const github = fakeFetch([
      { status: 200, body: { login: 'octocat' } },
      { status: 200, body: { default_branch: 'trunk' } },
      {
        status: 200,
        body: { encoding: 'base64', content: base64('{ "scripts": { "test": "node --test" } }') },
      },
      { status: 404, body: { message: 'Not Found' } },
      // acme/web has the intake label (ADR 0207).
      { status: 200, body: { name: 'foedrum:brew' } },
    ]);
    const gh = ghOver(github.fetch);
    const tools: string[] = [];
    const cwds: (string | undefined)[] = [];
    // gh api through the fake GitHub; git has nothing to commit; doctor's tools answer a version.
    const exec: ExecProcess = async (file, args, options) => {
      if (args[0] === 'api') return gh.exec(file, args, options);
      const top = atTop(args);
      if (top !== undefined) return top;
      if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '', output: '' };
      tools.push(`${file} ${args.join(' ')}`);
      cwds.push(options.cwd);
      return { exitCode: 0, stdout: '1.0.0\n', stderr: '', output: '1.0.0\n' };
    };
    let shown = '';
    const result = await initFromCheckout(dir.path, {
      exec,
      resolve: (name) => `/usr/bin/${name}`,
      // Never the user's own list (ADR 0114).
      denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
      // Never the user's own PATH (ADR 0210).
      shim: { env: { PATH: '' }, home: dir.path },
      terminal: {
        input: Readable.from(['acme/web\n', '\n', '\n', 'y\n']),
        output: {
          write: (text: string) => {
            shown += text;
          },
        },
      },
    });
    assert.ok(shown.includes('This is the Brewery in .: init updates its files\n'), shown);
    assert.ok(shown.includes('Read acme/web: base trunk, checks from package.json\n'), shown);
    assert.ok(shown.includes('Changed foedrum.jsonc\n'), shown);
    const config = readJsonc(readFileSync(join(dir.path, 'foedrum.jsonc'), 'utf8'), BreweryConfig);
    assert.ok(config.valid);
    // A node --test script's line saves its reports (ADR 0376).
    assert.match(
      String(config.value.repositories['acme/web']?.checks.test),
      /^node --test --experimental-test-coverage .*--test-reporter-destination=junit\.xml/,
    );
    assert.equal(readFileSync(join(dir.path, '.gitignore'), 'utf8'), '.foedrum/\n');
    assert.match(
      readFileSync(join(dir.path, '.claude', 'settings.json'), 'utf8'),
      /"foedrum@foedrum": true/,
    );
    // doctor ran through the same runner, and its report is shown before the plugin's commands.
    assert.ok(tools.length > 0);
    assert.ok(shown.includes('Foedrum doctor\n'), shown);
    assert.ok(shown.indexOf('Foedrum doctor') < shown.indexOf('claude plugin install'), shown);
    assert.ok(
      cwds.every((cwd) => cwd === undefined || cwd === dir.path),
      JSON.stringify(cwds),
    );
    assert.ok(shown.includes('claude plugin install foedrum@foedrum --scope project\n'), shown);
    assert.equal(result.stderr, '');
  });

  it('stops with one line when standard input ends before the answers', async () => {
    const answers = fakeFetch([{ status: 200, body: { login: 'octocat' } }]);
    const gh = ghOver(answers.fetch);
    const result = await initFromCheckout(dir.path, {
      exec: async (file, args, options) => atTop(args) ?? gh.exec(file, args, options),
      shim: { env: { PATH: '' }, home: dir.path },
      terminal: { input: Readable.from(['acme/brewery\n']), output: { write: () => true } },
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum init: no answer to "Target repositories/);
  });

  it("outside a clone, creates the repository and clones, commits and pushes through gh as git's credential helper, with no token anywhere (ADR 0207)", async () => {
    const empty = makeTempDir('init-main-new');
    const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    process.env.GH_TOKEN = 'ghp_madeUpTokenThatMustNotLeave';
    process.env.GITHUB_TOKEN = 'ghp_madeUpTokenThatMustNotLeave';
    try {
      const github = fakeFetch([
        { status: 200, body: { login: 'octocat' } },
        { status: 404, body: { message: 'Not Found' } },
        { status: 201, body: {} },
      ]);
      const gh = ghOver(github.fetch);
      const calls: { file: string; args: readonly string[]; cwd?: string; env: string }[] = [];
      const exec: ExecProcess = async (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd, env: JSON.stringify(options.env ?? {}) });
        if (args[0] === 'api') return gh.exec(file, args, options);
        const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', output: stdout });
        if (args[1] === '--show-cdup') {
          const stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
          return { exitCode: 128, stdout: '', stderr, output: stderr };
        }
        if (args[0] === 'clone') {
          mkdirSync(join(empty.path, 'foedrum-brewery', '.git'), { recursive: true });
          return ok();
        }
        if (args[0] === 'status') return ok('?? foedrum.jsonc\0');
        // A new clone has no commit yet.
        if (args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '', output: '' };
        if (['add', 'commit', 'push'].includes(args[0] ?? '')) return ok();
        return ok('1.0.0\n');
      };
      const result = await initFromCheckout(empty.path, {
        exec,
        resolve: (name) => `/usr/bin/${name}`,
        denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
        shim: { env: { PATH: '' }, home: empty.path },
        terminal: {
          input: Readable.from(['\n', 'foedrum-brewery\n', '\n', '\n', '\n', '\n']),
          output: { write: () => true },
        },
      });
      const clone = join(empty.path, 'foedrum-brewery');
      assert.deepStrictEqual(
        github.requests.map(({ method, url }) => `${method} ${url}`),
        [
          'GET https://api.github.com/user',
          'GET https://api.github.com/repos/octocat/foedrum-brewery',
          'POST https://api.github.com/user/repos',
        ],
      );
      const git = (command: string) => calls.find(({ args }) => args[0] === command);
      assert.deepStrictEqual(git('clone')?.args, [
        'clone',
        '--',
        'https://github.com/octocat/foedrum-brewery.git',
        'foedrum-brewery',
      ]);
      assert.equal(git('clone')?.cwd, empty.path);
      assert.equal(git('push')?.cwd, clone);
      assert.deepStrictEqual(git('push')?.args, ['push', '-u', 'origin', 'HEAD']);
      assert.ok(readFileSync(join(clone, 'foedrum.jsonc'), 'utf8').includes('foedrum-brewery'));
      // Neither gh nor git gets the token, in an argument or the environment it is given whole.
      const own = calls.filter(({ args }) =>
        ['api', 'clone', 'status', 'rev-parse', 'add', 'commit', 'push'].includes(args[0] ?? ''),
      );
      // Two of them ask git where the working folder and the new one are (ADR 0393).
      assert.equal(own.length, 11);
      for (const call of own) {
        assert.ok(!call.args.join(' ').includes('ghp_'), call.args.join(' '));
        assert.ok(/"path"/i.test(call.env) && !call.env.includes('ghp_'), call.args[0]);
      }
      // doctor runs in the new clone.
      const doctor = calls.filter(({ args }) => !own.some((call) => call.args === args));
      assert.ok(
        doctor.some(({ cwd }) => cwd === clone),
        JSON.stringify(doctor.map(({ cwd }) => cwd)),
      );
      assert.ok(
        doctor.every(({ cwd }) => cwd === undefined || cwd === clone),
        JSON.stringify(doctor.map(({ cwd }) => cwd)),
      );
      assert.equal(result.stderr, '');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      empty.remove();
    }
  });

  it("writes the foedrum command into a PATH folder in the home, running this checkout's main.ts (ADR 0210)", async () => {
    const machine = makeTempDir('init-main-shim');
    try {
      const clone = join(machine.path, 'brewery');
      const bin = join(machine.path, 'home', 'bin');
      mkdirSync(join(clone, '.git'), { recursive: true });
      writeFileSync(join(clone, 'foedrum.jsonc'), BREWERY);
      mkdirSync(bin, { recursive: true });
      const gh = ghOver(fakeFetch([{ status: 200, body: { login: 'octocat' } }]).fetch);
      const exec: ExecProcess = async (file, args, options) => {
        if (args[0] === 'api') return gh.exec(file, args, options);
        return { exitCode: 0, stdout: '', stderr: '', output: '' };
      };
      let shown = '';
      await initFromCheckout(clone, {
        exec,
        resolve: (name) => `/usr/bin/${name}`,
        denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
        shim: { env: { PATH: bin, Path: bin }, home: join(machine.path, 'home') },
        terminal: {
          input: Readable.from(['\n', '\n', '\n']),
          output: {
            write: (text: string) => {
              shown += text;
            },
          },
        },
      });
      const windows = process.platform === 'win32';
      const shim = join(bin, windows ? 'foedrum.cmd' : 'foedrum');
      const entry = join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');
      assert.ok(existsSync(shim), shown);
      assert.ok(readFileSync(shim, 'utf8').includes(entry), shown);
      if (!windows) assert.equal(statSync(shim).mode & 0o777, 0o755);
      assert.ok(shown.includes(`Wrote ${shim}\n`), shown);
    } finally {
      machine.remove();
    }
  });

  it('offers only a PATH entry that is a folder it can write, and runs main.ts from its own place, not the working directory (ADR 0210)', async () => {
    const machine = makeTempDir('init-main-shim-cwd');
    const was = process.cwd();
    try {
      const home = join(machine.path, 'home');
      const clone = join(machine.path, 'brewery');
      const bin = join(home, 'bin');
      const file = join(home, 'a-file');
      mkdirSync(join(clone, '.git'), { recursive: true });
      writeFileSync(join(clone, 'foedrum.jsonc'), BREWERY);
      mkdirSync(bin, { recursive: true });
      writeFileSync(file, '');
      // A checkout of its own as the working directory, which the shim must not run.
      mkdirSync(join(machine.path, 'src', 'cli'), { recursive: true });
      process.chdir(machine.path);
      const gh = ghOver(fakeFetch([{ status: 200, body: { login: 'octocat' } }]).fetch);
      const exec: ExecProcess = async (file, args, options) => {
        if (args[0] === 'api') return gh.exec(file, args, options);
        return { exitCode: 0, stdout: '', stderr: '', output: '' };
      };
      const path = [join(home, 'gone'), file, bin].join(delimiter);
      let shown = '';
      await initFromCheckout(clone, {
        exec,
        resolve: (name) => `/usr/bin/${name}`,
        denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
        shim: { env: { PATH: path, Path: path }, home },
        terminal: {
          input: Readable.from(['\n', '\n', '\n']),
          output: {
            write: (text: string) => {
              shown += text;
            },
          },
        },
      });
      assert.ok(shown.includes(`  1. ${bin}\n`), shown);
      assert.ok(!shown.includes('  2. '), shown);
      const shim = join(bin, process.platform === 'win32' ? 'foedrum.cmd' : 'foedrum');
      assert.ok(existsSync(shim), shown);
      const text = readFileSync(shim, 'utf8');
      assert.ok(text.includes(join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts')));
      assert.ok(!text.includes(machine.path), text);
    } finally {
      process.chdir(was);
      machine.remove();
    }
  });
});
