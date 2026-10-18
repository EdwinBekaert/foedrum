// `foedrum doctor` on the real machine (ADR 0021): the facts main.ts gathers (doctorFromCheckout)
// find the tools through PATH and read their versions through the process runner (npm.cmd through
// cmd.exe on Windows). What a machine has differs, so this checks the report's structure only; the
// report itself is in test/unit/cli.test.ts. gh's version and login check get canned answers, the
// login for a made-up host only (canned-gh-login.ts): no test asks the real gh for a login, or
// reads how fast it starts (ADR 0070, ADR 0073).

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveExecutable } from '../../src/platform/executables.ts';
import {
  type ExecProcess,
  execProcess,
  execProcessWith,
  processSpawner,
} from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import {
  cuedTimers,
  descheduled,
  hangGuardMs,
  hangGuardTimers,
  waitUntil,
} from '../helpers/load.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import {
  CANNED_GH_VERSION,
  cannedGhLogin,
  doctorHere,
  GH_LOGGED_IN_ANSWER,
  GH_NO_LOGIN_ANSWER,
  GH_VERSION_ANSWER,
  MADE_UP_CONFIG,
  MADE_UP_GH,
  MADE_UP_HOST,
} from './canned-gh-login.ts';
import { type CapturedAnswer, stubPath, writeStubTools } from './stub-tools.ts';

const VERSION = String.raw`\d+(?:\.\d+)+`;

describe('foedrum doctor on this machine', () => {
  it('reports each tool, the isolation level and an exit code that matches', async () => {
    const dir = makeTempDir('doctor-machine');
    writeFileSync(join(dir.path, 'foedrum.jsonc'), MADE_UP_CONFIG);
    // A tool the runner killed at its deadline may hold the folder a moment longer on Windows.
    const { exitCode, stdout, stderr } = await doctorHere(dir.path).finally(() =>
      removeTree(dir.path),
    );
    assert.equal(stderr, '');
    const lines = stdout.split('\n');
    assert.equal(lines[0], 'Foedrum doctor');
    const row = (name: string): string | undefined =>
      lines.find((line) => line.startsWith(`  ${name} `));
    assert.match(row('node') ?? '', new RegExp(`^  node +${VERSION}$`));
    // CI has npm and git everywhere; npm is npm.cmd on Windows.
    assert.match(row('npm') ?? '', new RegExp(`^  npm +${VERSION} +\\S`));
    assert.match(row('git') ?? '', new RegExp(`^  git +${VERSION} +\\S`));
    // gh is found at a made-up path and answers its canned version, on every machine.
    assert.equal(row('gh')?.replace(/ +/g, ' '), ` gh ${CANNED_GH_VERSION} ${MADE_UP_GH}`);
    // foedrum.jsonc names the made-up host, whose canned answer is logged in: doctor names no
    // login to make.
    assert.ok(!lines.some((line) => line.includes('gh auth login')), stdout);
    assert.match(row('claude') ?? '', new RegExp(`^  claude +(?:missing|${VERSION} +\\S.*)$`));
    const linux = process.platform === 'linux';
    assert.equal(row('bwrap') !== undefined, linux);
    assert.equal(row('socat') !== undefined, linux);
    // Where the machine has them, the parser reads a version from what they really print.
    for (const name of ['bwrap', 'socat']) {
      const line = row(name);
      if (line !== undefined && !/ missing$/.test(line)) {
        assert.match(line, new RegExp(`^  ${name} +${VERSION} +\\S`));
      }
    }
    const container = lines.find((line) => line.startsWith('Container: '));
    // A container runtime may be there without answering (docker.exe on the Windows runner, #99),
    // but one that printed a version must have it read.
    if (container !== undefined && !container.startsWith('Container: no ')) {
      assert.match(
        container,
        new RegExp(
          `^Container: (?:podman|docker) (?:${VERSION} at \\S.*; the container level is available|at \\S.* does not answer its version.*; the container level is not available)$`,
        ),
      );
      if (container.includes(' does not answer its version')) {
        assert.doesNotMatch(container, new RegExp(`its version \\(.*${VERSION}`));
      }
    }
    const isolation = lines.find((line) => line.startsWith('Isolation: '));
    const expected = { win32: 'permissions only', darwin: 'sandboxed' }[process.platform as string];
    assert.match(isolation ?? '', /^Isolation: (?:sandboxed|permissions only) \(.+\)$/);
    if (expected !== undefined) assert.ok(isolation?.startsWith(`Isolation: ${expected} (`));
    assert.ok(lines.some((line) => line.startsWith('Container: ')));
    const required = lines.some((line) => / \(required\): /.test(line));
    assert.equal(exitCode, required ? 1 : 0);
  });
});

// doctor's real shell (#212): every tool but node and git is a stub on a PATH of its own that prints
// what the real tool printed, so the report is exact on every machine. git stays real, with a
// global configuration of the test's own and no system one; its row is checked against its own
// path and then taken as it is.
describe('foedrum doctor with stub tools', () => {
  const realGit = resolveExecutable('git') ?? '';
  const answers = (started: string): Record<string, CapturedAnswer> => ({
    'npm --version': { stdout: '11.6.2\n' },
    'gh --version': { stdout: GH_VERSION_ANSWER },
    [`gh auth status --hostname ${MADE_UP_HOST}`]: { stdout: GH_LOGGED_IN_ANSWER },
    'claude --version': { stdout: '2.1.301 (Claude Code)\n' },
    'bwrap --version': { stdout: 'bubblewrap 0.9.0\n' },
    'socat -V': {
      stdout:
        'socat by Gerhard Rieger and contributors - see www.dest-unreach.org\nsocat version 1.7.4.4 on 06 Nov 2022 08:15:51\n',
    },
    'podman --version': started === '' ? { stdout: 'podman version 5.2.0\n' } : { hang: started },
    'docker --version': { stdout: 'Docker version 27.3.1, build ce12230\n' },
  });
  const ghHelper = `[credential "https://${MADE_UP_HOST}"]\n\thelper =\n\thelper = !gh auth git-credential\n`;

  // A loaded machine (#212): right after doctor has started its probes, the test process loses
  // 3.1 s, more than a container runtime's 3 s, without using the CPU (ADR 0070).
  const loaded = (exec: ExecProcess): ExecProcess => {
    let first = true;
    return (file, args, options) => {
      if (first) {
        first = false;
        setImmediate(() => descheduled(3_100));
      }
      return exec(file, args, options);
    };
  };

  const doctorWithStubs = async (
    dir: string,
    stubs: Record<string, CapturedAnswer>,
    gitconfig: string,
    exec: ExecProcess,
  ) => {
    const bin = join(dir, 'bin');
    writeStubTools(bin, stubs);
    const global = join(dir, 'gitconfig');
    writeFileSync(global, gitconfig);
    writeFileSync(join(dir, 'foedrum.jsonc'), MADE_UP_CONFIG);
    const ours = {
      PATH: bin,
      GIT_CONFIG_GLOBAL: global,
      GIT_CONFIG_NOSYSTEM: '1',
      // The folder is inside Foedrum's own checkout: git must not read its local settings.
      GIT_CEILING_DIRECTORIES: dirname(dir),
    };
    // Every process gets the stubs' PATH, also gh, whose environment doctor strips of tokens.
    const withEnv: ExecProcess = (file, args, options) => {
      const base = Object.entries(options.env ?? process.env).filter(
        ([key]) => !/^path$/i.test(key),
      );
      return exec(file, args, { ...options, env: { ...Object.fromEntries(base), ...ours } });
    };
    const resolve = (name: string) =>
      name === 'git' ? realGit : resolveExecutable(name, { env: ours });
    const { exitCode, stdout, stderr } = await doctorHere(dir, loaded(withEnv), resolve);
    const lines = stdout.split('\n');
    const git = lines.findIndex((line) => line.startsWith('  git '));
    const gitRow = lines[git] ?? '';
    assert.ok(gitRow.endsWith(`  ${realGit}`), gitRow);
    assert.match(gitRow.slice(0, -realGit.length), /^ {2}git +\d+(?:\.\d+)+ +$/);
    lines[git] = '  git     <real git>';
    return {
      exitCode,
      report: lines.join('\n'),
      stderr,
      at: (name: string) => stubPath(bin, name),
    };
  };

  // The lines that differ by platform: the sandbox's tools, the isolation level and its problem.
  const sandbox = (at: (name: string) => string, bwrap: boolean) => {
    switch (process.platform) {
      case 'linux':
        return {
          rows: [
            bwrap ? `  bwrap   0.9.0     ${at('bwrap')}` : '  bwrap   missing',
            `  socat   1.7.4.4   ${at('socat')}`,
          ],
          isolation: [
            bwrap
              ? 'Isolation: sandboxed (bubblewrap and socat)'
              : 'Isolation: permissions only (the sandbox needs bubblewrap and socat)',
          ],
          problems: bwrap
            ? []
            : ['  bubblewrap (bwrap) not found: install bubblewrap for the sandboxed level'],
        };
      case 'win32':
        return {
          rows: [],
          isolation: [
            'Isolation: permissions only (native Windows has no sandbox for shell commands)',
            '  For untrusted repositories, run Foedrum inside WSL2, where shell commands are sandboxed.',
          ],
          problems: [],
        };
      default:
        return { rows: [], isolation: ['Isolation: sandboxed (macOS Seatbelt)'], problems: [] };
    }
  };

  // The probes' deadlines only guard against a hang: a loaded machine may start a stub late.
  const guarded = execProcessWith(processSpawner, hangGuardTimers);

  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('doctor-stubs');
  });
  // A stub the runner killed at its deadline may hold the folder a moment longer on Windows.
  afterEach(() => removeTree(dir.path));

  it('reports every tool, its version and its path, and exits 0', async () => {
    const run = await doctorWithStubs(dir.path, answers(''), ghHelper, guarded);
    const { at } = run;
    const platform = sandbox(at, true);
    assert.equal(run.stderr, '');
    assert.equal(
      run.report,
      [
        'Foedrum doctor',
        '',
        `  node    ${process.versions.node}`,
        `  npm     11.6.2    ${at('npm')}`,
        '  git     <real git>',
        `  gh      ${CANNED_GH_VERSION}  ${at('gh')}`,
        `  claude  2.1.301   ${at('claude')}`,
        ...platform.rows,
        '',
        ...platform.isolation,
        `Container: podman 5.2.0 at ${at('podman')}; the container level is available`,
        '',
        'Foedrum has everything it needs.',
        '',
      ].join('\n'),
    );
    assert.equal(run.exitCode, 0);
  });

  it('reports the tools that are missing, a missing login and credential helper, and exits 1', async () => {
    const all = answers('');
    const stubs = Object.fromEntries(
      Object.entries(all).filter(([line]) => !/^(?:npm|claude|bwrap|podman) /.test(line)),
    );
    stubs[`gh auth status --hostname ${MADE_UP_HOST}`] = {
      exitCode: 1,
      stderr: GH_NO_LOGIN_ANSWER,
    };
    const run = await doctorWithStubs(dir.path, stubs, '', guarded);
    const { at } = run;
    const platform = sandbox(at, false);
    const host = MADE_UP_HOST;
    assert.equal(run.stderr, '');
    assert.equal(
      run.report,
      [
        'Foedrum doctor',
        '',
        `  node    ${process.versions.node}`,
        '  npm     missing',
        '  git     <real git>',
        `  gh      ${CANNED_GH_VERSION}  ${at('gh')}`,
        '  claude  missing',
        ...platform.rows,
        '',
        ...platform.isolation,
        `Container: docker 27.3.1 at ${at('docker')}; the container level is available`,
        '',
        'Problems:',
        '  npm not found: Foedrum is installed and updated with npm, which comes with Node',
        `  gh is not logged in to ${host} (required): run gh auth login --hostname ${host}`,
        `  git has no credential helper for https://${host}: run gh auth setup-git --hostname ${host}, so git pushes with gh's login`,
        '  claude not found (required): install Claude Code, https://code.claude.com/docs/en/setup',
        ...platform.problems,
        '',
        'Foedrum cannot run brewers until the required problems are fixed.',
        '',
      ].join('\n'),
    );
    assert.equal(run.exitCode, 1);
  });

  it('passes over a container runtime that hangs for the next one', {
    timeout: hangGuardMs,
  }, async () => {
    const started = join(dir.path, 'started');
    // podman's deadline comes once its stub runs, however late a loaded machine starts it.
    const deadline = cuedTimers();
    const cued = execProcessWith(processSpawner, deadline);
    const exec: ExecProcess = (file, args, options) =>
      (parse(file).name === 'podman' ? cued : guarded)(file, args, options);
    const running = doctorWithStubs(dir.path, answers(started), ghHelper, exec);
    await waitUntil('podman to start', () => existsSync(started));
    deadline.fire();
    const run = await running;
    const { at } = run;
    const platform = sandbox(at, true);
    assert.equal(run.stderr, '');
    assert.equal(
      run.report,
      [
        'Foedrum doctor',
        '',
        `  node    ${process.versions.node}`,
        `  npm     11.6.2    ${at('npm')}`,
        '  git     <real git>',
        `  gh      ${CANNED_GH_VERSION}  ${at('gh')}`,
        `  claude  2.1.301   ${at('claude')}`,
        ...platform.rows,
        '',
        ...platform.isolation,
        `Container: docker 27.3.1 at ${at('docker')}; the container level is available`,
        '',
        'Foedrum has everything it needs.',
        '',
      ].join('\n'),
    );
    assert.equal(run.exitCode, 0);
  });
});

describe('foedrum doctor in a Brewery', () => {
  it('reads foedrum.jsonc in the working directory and refuses two repositories with one alias', async () => {
    const dir = makeTempDir('doctor-config');
    try {
      const checks = { build: null, typecheck: null, lint: null, format: null, test: null };
      const config = {
        repositories: {
          'acme/web': { checks, alias: 'app' },
          'acme/api': { checks, alias: 'app' },
        },
      };
      writeFileSync(join(dir.path, 'foedrum.jsonc'), JSON.stringify(config));
      const { exitCode, stdout } = await doctorHere(dir.path);
      assert.equal(exitCode, 1);
      assert.match(
        stdout,
        /^ {2}foedrum\.jsonc is not valid \(required\): .*The alias app is already the alias of acme\/web/m,
      );
    } finally {
      await removeTree(dir.path);
    }
  });
});

// doctor reads git's own credential settings (ADR 0073): the format the unit tests' fixtures stand
// in for, from the real git, with a global configuration of the test's own and no system one.
// gh answers from captured output here too.
describe("foedrum doctor and git's credential helper", () => {
  const advice = async (helpers: string[]): Promise<string[]> => {
    const dir = makeTempDir('doctor-credentials');
    try {
      const global = join(dir.path, 'gitconfig');
      const lines = helpers.map((helper) => `\thelper = ${helper}\n`).join('');
      writeFileSync(global, `[credential "https://${MADE_UP_HOST}"]\n${lines}`);
      writeFileSync(join(dir.path, 'foedrum.jsonc'), MADE_UP_CONFIG);
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: global,
        GIT_CONFIG_NOSYSTEM: '1',
        // The folder is inside Foedrum's own checkout: git must not read its local settings.
        GIT_CEILING_DIRECTORIES: dirname(dir.path),
      };
      const { stdout } = await doctorHere(
        dir.path,
        cannedGhLogin((file, args, options) => execProcess(file, args, { ...options, env })),
      );
      return stdout
        .split('\n')
        .filter((line) => /credential helper|credentials, not gh/.test(line));
    } finally {
      await removeTree(dir.path);
    }
  };

  it('is content with the helper gh auth setup-git writes', async () => {
    assert.deepEqual(await advice(['', '!gh auth git-credential']), []);
  });

  it('names the helper git asks first when it is not gh, and when there is none', async () => {
    const fix = `run gh auth setup-git --hostname ${MADE_UP_HOST}, so git pushes with gh's login`;
    assert.deepEqual(await advice(['store', '!gh auth git-credential']), [
      `  git asks store for https://${MADE_UP_HOST} credentials, not gh: ${fix}`,
    ]);
    assert.deepEqual(await advice([]), [
      `  git has no credential helper for https://${MADE_UP_HOST}: ${fix}`,
    ]);
  });
});
