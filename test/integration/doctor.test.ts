// `foedrum doctor`'s real shell (ADR 0021): the facts main.ts gathers (doctorFromCheckout) find the
// tools through PATH and read their versions through the process runner (a .cmd file through
// cmd.exe on Windows). Every tool but node and git is a stub on a PATH of its own that prints what
// the real tool printed (stub-tools.ts), so the report is exact on every machine, and no test asks
// the real gh for a login or reads how fast a tool starts (#212, ADR 0070, ADR 0073). git stays
// real, with a global configuration of the test's own and no system one; its row is checked
// against its own path and then taken as it is. What doctor makes of other answers is in
// test/unit/cli.test.ts.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { type ExecProcess, execProcessWith, processSpawner } from '../../src/platform/processes.ts';
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
  doctorHere,
  GH_LOGGED_IN_ANSWER,
  GH_NO_LOGIN_ANSWER,
  GH_VERSION_ANSWER,
  MADE_UP_CONFIG,
  MADE_UP_HOST,
} from './canned-gh-login.ts';
import { type CapturedAnswer, stubPath, writeStubTools } from './stub-tools.ts';

const realGit = resolveExecutable('git') ?? '';
// doctor runs in a Brewery without files of its own, so every file under Foedrum's defaults/ is in
// use (ADR 0098), listed here from the folders themselves.
const defaultsRoot = join(import.meta.dirname, '..', '..', 'defaults');
const defaultsInUse = (['recipes', 'brewers', 'lenses'] as const).flatMap((folder) => {
  const extension = folder === 'recipes' ? '.jsonc' : '.md';
  const names = existsSync(join(defaultsRoot, folder))
    ? readdirSync(join(defaultsRoot, folder)).filter((name) => name.endsWith(extension))
    : [];
  return names.sort().map((name) => `defaults/${folder}/${name}`);
});
const DEFAULTS_LINE = `Defaults in use: ${defaultsInUse.join(', ')} (a Brewery file of the same name replaces one)`;
// The default brewers' prompts (ADR 0141), read from the report, since their sizes change with
// every edit of a default brewer or lens: one row per file in defaults/brewers/, by its name and
// path, with its bytes and their estimate in tokens. Their measure is in test/unit/doctor.test.ts.
const defaultBrewers = existsSync(join(defaultsRoot, 'brewers'))
  ? readdirSync(join(defaultsRoot, 'brewers'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => parse(name).name)
      .sort()
  : [];
const promptBlock = (report: string): string[] => {
  const lines = report.split('\n');
  const start = lines.indexOf('Brewer prompts (instructions and lens inputs, ADR 0141):');
  assert.notEqual(start, -1);
  const rows = lines.slice(start + 1, lines.indexOf('', start));
  assert.deepEqual(
    rows.map(
      (row) => /^ {2}(\S+) +defaults\/brewers\/\1\.md +\d+ bytes +~\d+ tokens$/.exec(row)?.[1],
    ),
    defaultBrewers,
  );
  for (const row of rows) {
    const [, bytes = '', tokens = ''] = /(\d+) bytes +~(\d+) tokens$/.exec(row) ?? [];
    assert.equal(Number(tokens), Math.ceil(Number(bytes) / 4));
  }
  return [lines[start] ?? '', ...rows, ''];
};
// doctorHere gives doctor no denylist, so it never reads the user's own (ADR 0114).
const DENYLIST_LINE =
  'Denylist: none (optional; the local gate reads FOEDRUM_DENYLIST or /made-up/denylist.txt, ADR 0114)';
// What each tool prints for its version, in its own format, with the versions of the captures in
// test/unit (doctor.test.ts, doctor-facts.test.ts and cli.test.ts's report); gh's come from
// canned-gh-login.ts. The real tools' output is no longer read here (ADR 0075).
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
  // The made-up host, unless the test wrote a foedrum.jsonc of its own.
  const config = join(dir, 'foedrum.jsonc');
  if (!existsSync(config)) writeFileSync(config, MADE_UP_CONFIG);
  const ours = {
    PATH: bin,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: '1',
    // The folder is inside Foedrum's own checkout: git must not read its local settings.
    GIT_CEILING_DIRECTORIES: dirname(dir),
  };
  // Every process gets the stubs' PATH, also gh, whose environment doctor strips of tokens.
  const withEnv: ExecProcess = (file, args, options) => {
    const base = Object.entries(options.env ?? process.env).filter(([key]) => !/^path$/i.test(key));
    return exec(file, args, { ...options, env: { ...Object.fromEntries(base), ...ours } });
  };
  const resolve = (name: string) =>
    name === 'git' ? realGit : resolveExecutable(name, { env: ours });
  const { exitCode, stdout, stderr } = await doctorHere(dir, withEnv, resolve);
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

// What each level keeps from gh's login (ADR 0082, #229): the sandbox docs settle the hosts file
// and the token variables, not the OS keyring.
const sandboxHides =
  "hides gh's hosts file at its default path and the token variables from a brewer's shell commands and keeps them from reaching GitHub; Claude Code's docs don't say whether the sandbox stops a read from the OS keyring.";
const writtenDown =
  'A login a brewer did read is stopped at the push (ADR 0079) and left out of the pull request and the status comment (ADR 0088) when it looks like one.';
// Where check steps run (ADR 0076): outside any sandbox only on native Windows.
const onWindows = process.platform === 'win32';
const keyring = (sandboxedLevel: string) =>
  `  ${onWindows ? 'A brewer or a check step runs' : 'A brewer runs'} as you here, so it can still read gh's login from the OS keyring or its hosts file. ${sandboxedLevel} ${sandboxHides}${sandboxedLevel.startsWith('In WSL2') ? " Under WSL, it doesn't hide the Windows user's logins under /mnt (ADR 0087)." : ''} For brewers, the container level mounts only the worktree, which closes both. ${writtenDown} ${onWindows ? "On native Windows, check steps run outside any sandbox, so they can still read gh's login (ADR 0076)." : "Check steps run only in bubblewrap's sandbox, with no network and the home folder hidden; where it cannot start, they do not run (ADR 0076)."}`;
const checkStepKeyring = `  The sandbox ${sandboxHides} ${writtenDown} Check steps run in an OS sandbox of their own, with no network and the home folder hidden, so they can't read gh's login (ADR 0076).`;

// The lines that differ by platform: the sandbox's tools, the isolation level, its advice and its
// problem.
const sandbox = (at: (name: string) => string, bwrap: boolean) => {
  switch (process.platform) {
    case 'linux':
      return {
        rows: [
          bwrap ? `  bwrap   0.9.0     ${at('bwrap')}` : '  bwrap   missing',
          `  socat   1.7.4.4   ${at('socat')}`,
        ],
        isolation: bwrap
          ? ['Isolation: sandboxed (bubblewrap and socat)', checkStepKeyring]
          : [
              'Isolation: permissions only (the sandbox needs bubblewrap and socat)',
              keyring('The sandboxed level (bubblewrap and socat)'),
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
          keyring('In WSL2, the sandboxed level'),
        ],
        problems: [],
      };
    default:
      return {
        rows: [],
        isolation: ['Isolation: sandboxed (macOS Seatbelt)', checkStepKeyring],
        problems: [],
      };
  }
};

// The probes' deadlines only guard against a hang: a loaded machine may start a stub late.
const guarded = execProcessWith(processSpawner, hangGuardTimers);

describe('foedrum doctor with stub tools', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('doctor-stubs');
  });
  // A stub the runner killed at its deadline may hold the folder a moment longer on Windows.
  afterEach(() => removeTree(dir.path));

  it('reports every tool, its version and its path, and exits 0', async () => {
    const run = await doctorWithStubs(dir.path, answers(''), ghHelper, loaded(guarded));
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
        DEFAULTS_LINE,
        DENYLIST_LINE,
        '',
        ...promptBlock(run.report),
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
    const run = await doctorWithStubs(dir.path, stubs, '', loaded(guarded));
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
        DEFAULTS_LINE,
        DENYLIST_LINE,
        '',
        ...promptBlock(run.report),
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
    const running = doctorWithStubs(dir.path, answers(started), ghHelper, loaded(exec));
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
        DEFAULTS_LINE,
        DENYLIST_LINE,
        '',
        ...promptBlock(run.report),
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
      // A config that is not valid names no host, so gh is asked about github.com.
      const stubs = { ...answers(''), 'gh auth status --hostname github.com': { exitCode: 1 } };
      const { exitCode, report } = await doctorWithStubs(dir.path, stubs, ghHelper, guarded);
      assert.equal(exitCode, 1);
      assert.match(
        report,
        /^ {2}foedrum\.jsonc is not valid \(required\): .*The alias app is already the alias of acme\/web/m,
      );
    } finally {
      await removeTree(dir.path);
    }
  });
});

// doctor reads git's own credential settings (ADR 0073): the format the unit tests' fixtures stand
// in for, from the real git.
describe("foedrum doctor and git's credential helper", () => {
  const advice = async (helpers: string[]): Promise<string[]> => {
    const dir = makeTempDir('doctor-credentials');
    try {
      const lines = helpers.map((helper) => `\thelper = ${helper}\n`).join('');
      const gitconfig = `[credential "https://${MADE_UP_HOST}"]\n${lines}`;
      const { report } = await doctorWithStubs(dir.path, answers(''), gitconfig, guarded);
      return report
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
