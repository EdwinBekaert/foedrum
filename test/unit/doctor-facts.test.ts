// `foedrum doctor`'s shell with a fake PATH and a fake process runner (ADR 0021). The real
// machine is in test/integration/doctor.test.ts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { diagnose, formatDiagnosis } from '../../src/cli/doctor.ts';
import { type DoctorShell, gatherDoctorFacts } from '../../src/cli/doctor-facts.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';

const onPath: Record<string, string> = {
  npm: '/usr/bin/npm',
  git: '/usr/bin/git',
  claude: '/home/brewer/.local/bin/claude',
  socat: '/usr/bin/socat',
};

const answers: Record<string, ExecResult> = {
  '/usr/bin/npm': { exitCode: 0, stdout: '11.6.2\n', stderr: '', output: '11.6.2\n' },
  '/usr/bin/git': {
    exitCode: 0,
    stdout: 'git version 2.47.1\n',
    stderr: '',
    output: 'git version 2.47.1\n',
  },
  '/home/brewer/.local/bin/claude': {
    exitCode: null,
    stdout: '',
    stderr: '',
    output: '',
    killed: 'timed-out',
  },
  '/usr/bin/socat': {
    exitCode: 0,
    stdout: 'socat version 1.7.4.4\n',
    stderr: '',
    output: 'socat version 1.7.4.4\n',
  },
  // git config exits 1 when no setting matches.
  '/usr/bin/git config --null --get-regexp ^credential\\.': {
    exitCode: 1,
    stdout: '',
    stderr: '',
    output: '',
  },
};

// The call doctor makes to read git's credential helpers (ADR 0073).
const CREDENTIALS = ['config', '--null', '--get-regexp', '^credential\\.'];

// What a fake shell finds on PATH and answers besides the tools above.
interface Extra {
  onPath: Record<string, string>;
  answers: Record<string, ExecResult>;
}

const fakeShell = (extra: Extra = { onPath: {}, answers: {} }) => {
  const calls: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
  const exec: ExecProcess = async (file, args, options) => {
    calls.push({ file, args, options });
    // By the whole command first, then by the program alone.
    const command = [file, ...args].join(' ');
    const answer =
      extra.answers[command] ?? answers[command] ?? extra.answers[file] ?? answers[file];
    if (answer === undefined) throw new Error(`unexpected ${file}`);
    return answer;
  };
  const shell: DoctorShell = {
    exec,
    resolve: (name) => extra.onPath[name] ?? onPath[name],
    platform: 'linux',
    kernelRelease: '6.8.0-45-generic',
    node: '24.20.0',
    execPath: '/usr/bin/node',
    cwd: '/work/brewery',
  };
  return { calls, shell };
};

describe('gatherDoctorFacts', () => {
  it('passes the platform, kernel release and Node version on', async () => {
    const { shell } = fakeShell();
    const facts = await gatherDoctorFacts(shell);
    assert.equal(facts.platform, 'linux');
    assert.equal(facts.kernelRelease, '6.8.0-45-generic');
    assert.equal(facts.node, '24.20.0');
  });

  it('runs the version command of each tool on PATH, by its resolved path', async () => {
    const { calls, shell } = fakeShell();
    await gatherDoctorFacts(shell);
    assert.deepEqual(
      calls.map(({ file, args }) => [file, args]).sort(),
      [
        ['/home/brewer/.local/bin/claude', ['--version']],
        ['/usr/bin/git', ['--version']],
        ['/usr/bin/git', CREDENTIALS],
        ['/usr/bin/npm', ['--version']],
        // socat has no --version.
        ['/usr/bin/socat', ['-V']],
      ].sort(),
    );
  });

  it('runs every version command in the working directory with a deadline', async () => {
    const { calls, shell } = fakeShell();
    await gatherDoctorFacts(shell);
    for (const { options } of calls) {
      assert.equal(options.cwd, '/work/brewery');
      assert.equal(options.timeoutMs, 10_000);
    }
  });

  it('records each tool with its path and answer, and the tools not on PATH as undefined', async () => {
    const { shell } = fakeShell();
    assert.deepEqual((await gatherDoctorFacts(shell)).tools, {
      npm: { path: '/usr/bin/npm', exitCode: 0, output: '11.6.2\n' },
      git: { path: '/usr/bin/git', exitCode: 0, output: 'git version 2.47.1\n' },
      gh: undefined,
      // A command the runner killed at its deadline says so first, so doctor can show why.
      claude: {
        path: '/home/brewer/.local/bin/claude',
        exitCode: null,
        output: 'timed out after 10 s\n',
      },
      bwrap: undefined,
      socat: { path: '/usr/bin/socat', exitCode: 0, output: 'socat version 1.7.4.4\n' },
      podman: undefined,
      docker: undefined,
    });
  });

  // Brewers run only in a Job Object on Windows (ADR 0039), so doctor tries one: node, doing
  // nothing, held in a job by the runner.
  it('on Windows, holds node in a Job Object and records how it answered', async () => {
    const said =
      'node.exe: cannot run in a Job Object: PowerShell runs in ConstrainedLanguage mode';
    const refused: ExecResult = { exitCode: null, stdout: '', stderr: said, output: said };
    const { calls, shell } = fakeShell({ onPath: {}, answers: { '/usr/bin/node': refused } });
    const facts = await gatherDoctorFacts({ ...shell, platform: 'win32' });
    const held = calls.filter(({ options }) => options.jobObject === true);
    assert.deepEqual(
      held.map(({ file, args, options }) => [file, args, options.cwd, options.timeoutMs]),
      [['/usr/bin/node', ['-e', ''], '/work/brewery', 10_000]],
    );
    assert.deepEqual(facts.jobObject, { exitCode: null, output: said });
  });

  it('holds nothing in a Job Object elsewhere', async () => {
    const { calls, shell } = fakeShell();
    const facts = await gatherDoctorFacts(shell);
    assert.equal(facts.jobObject, undefined);
    assert.ok(calls.every(({ options }) => options.jobObject !== true));
  });

  // A runtime waiting for its daemon is the common case (#99: docker.exe on the Windows runner).
  const timedOut: ExecResult = {
    exitCode: null,
    stdout: '',
    stderr: '',
    output: '',
    killed: 'timed-out',
  };
  const hangingDocker: Extra = {
    onPath: { docker: '/usr/bin/docker' },
    answers: { '/usr/bin/docker': timedOut },
  };

  it('says first that the Job Object probe was killed at its deadline', async () => {
    const { shell } = fakeShell({ onPath: {}, answers: { '/usr/bin/node': timedOut } });
    const facts = await gatherDoctorFacts({ ...shell, platform: 'win32' });
    assert.deepEqual(facts.jobObject, { exitCode: null, output: 'timed out after 10 s\n' });
  });

  it('gives a container runtime a shorter deadline than the other tools', async () => {
    const { calls, shell } = fakeShell(hangingDocker);
    await gatherDoctorFacts(shell);
    const docker = calls.find(({ file }) => file === '/usr/bin/docker');
    assert.equal(docker?.options.timeoutMs, 3_000);
  });

  it('gives Podman the same shorter deadline', async () => {
    const { calls, shell } = fakeShell({
      onPath: { podman: '/usr/bin/podman' },
      answers: { '/usr/bin/podman': timedOut },
    });
    await gatherDoctorFacts(shell);
    const podman = calls.find(({ file }) => file === '/usr/bin/podman');
    assert.equal(podman?.options.timeoutMs, 3_000);
  });

  it('reports a container runtime that times out as not available', async () => {
    const { shell } = fakeShell(hangingDocker);
    const report = formatDiagnosis(diagnose(await gatherDoctorFacts(shell)));
    assert.ok(
      report.includes(
        '\nContainer: docker at /usr/bin/docker does not answer its version (timed out after 3 s); the container level is not available\n',
      ),
      report,
    );
  });
});

// Foedrum reaches GitHub only through gh's own login (ADR 0073).
describe("gatherDoctorFacts: gh's login and git's credential helpers", () => {
  const out = (stdout: string, exitCode = 0, stderr = ''): ExecResult => ({
    exitCode,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  });
  const withGh: Extra = {
    onPath: { gh: '/usr/bin/gh' },
    answers: {
      '/usr/bin/gh': out('gh version 2.102.0 (2026-09-30)\n'),
      '/usr/bin/gh auth status --hostname ghe.example': out(
        'ghe.example\n  ✓ Logged in to ghe.example account brewer (keyring)\n',
      ),
      '/usr/bin/gh auth status --hostname github.com': out(
        '',
        1,
        'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
      ),
      // A warning on stderr stays out of the listing, which is NUL-separated stdout only.
      '/usr/bin/git config --null --get-regexp ^credential\\.': out(
        'credential.https://ghe.example.helper\n!/usr/bin/gh auth git-credential\0',
        0,
        'warning: unable to access /home/brewer/.config/git/attributes\n',
      ),
    },
  };
  const ghe = '{ "repositories": {}, "githubApi": "https://ghe.example/api/v3" }';

  it('asks gh about the host foedrum.jsonc names, and git for its credential settings', async () => {
    const { calls, shell } = fakeShell(withGh);
    const facts = await gatherDoctorFacts({ ...shell, readFile: () => ghe });
    assert.deepEqual(facts.github, {
      host: 'ghe.example',
      login: {
        exitCode: 0,
        output: 'ghe.example\n  ✓ Logged in to ghe.example account brewer (keyring)\n',
      },
      credentials: {
        exitCode: 0,
        output: 'credential.https://ghe.example.helper\n!/usr/bin/gh auth git-credential\0',
      },
    });
    const asked = calls.filter(({ args }) => args[0] === 'auth' || args[0] === 'config');
    assert.deepEqual(
      asked.map(({ file, args, options }) => [file, args, options.cwd, options.timeoutMs]),
      [
        ['/usr/bin/gh', ['auth', 'status', '--hostname', 'ghe.example'], '/work/brewery', 10_000],
        ['/usr/bin/git', CREDENTIALS, '/work/brewery', 10_000],
      ],
    );
  });

  it('asks gh without the token variables, which gh would take for a login', async () => {
    const { calls, shell } = fakeShell(withGh);
    await gatherDoctorFacts({
      ...shell,
      env: { PATH: '/usr/bin', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c' },
    });
    const status = calls.find(({ args }) => args[0] === 'auth');
    assert.deepEqual(status?.options.env, { PATH: '/usr/bin' });
  });

  it('keeps what gh said when it has no login, from stderr too', async () => {
    const { shell } = fakeShell(withGh);
    const facts = await gatherDoctorFacts(shell);
    assert.deepEqual(facts.github?.login, {
      exitCode: 1,
      output: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
    });
    // No foedrum.jsonc: github.com.
    assert.equal(facts.github?.host, 'github.com');
  });

  it('asks about the host the shell names, before the one foedrum.jsonc names', async () => {
    const { calls, shell } = fakeShell(withGh);
    const facts = await gatherDoctorFacts({ ...shell, githubHost: 'github.com' });
    assert.equal(facts.github?.host, 'github.com');
    assert.ok(calls.some(({ args }) => args.join(' ') === 'auth status --hostname github.com'));
  });

  it('has no login without gh, and no helpers without git', async () => {
    const { shell } = fakeShell();
    assert.equal((await gatherDoctorFacts(shell)).github?.login, undefined);
    const noGit = fakeShell(withGh);
    const facts = await gatherDoctorFacts({
      ...noGit.shell,
      resolve: (name) => (name === 'git' ? undefined : noGit.shell.resolve(name)),
    });
    assert.equal(facts.github?.credentials, undefined);
    assert.equal(facts.github?.login?.exitCode, 1);
  });

  it('says first that gh was killed at its deadline', async () => {
    const killed: ExecResult = { ...out(''), exitCode: null, killed: 'timed-out' };
    const { shell } = fakeShell({
      onPath: withGh.onPath,
      answers: { ...withGh.answers, '/usr/bin/gh auth status --hostname github.com': killed },
    });
    const facts = await gatherDoctorFacts(shell);
    assert.deepEqual(facts.github?.login, { exitCode: null, output: 'timed out after 10 s\n' });
  });
});

describe('gatherDoctorFacts: the Brewery config', () => {
  it('reads foedrum.jsonc in the working directory', async () => {
    const { shell } = fakeShell();
    const read: string[] = [];
    const facts = await gatherDoctorFacts({
      ...shell,
      readFile: (path) => {
        read.push(path);
        return '{ "repositories": {} }';
      },
    });
    assert.deepEqual(read, [join('/work/brewery', 'foedrum.jsonc')]);
    assert.equal(facts.config, '{ "repositories": {} }');
  });

  it('has no config where there is no foedrum.jsonc', async () => {
    const { shell } = fakeShell();
    const facts = await gatherDoctorFacts({ ...shell, readFile: () => undefined });
    assert.equal('config' in facts, false);
  });

  it('keeps a foedrum.jsonc it cannot read as the reason, instead of failing', async () => {
    const { shell } = fakeShell();
    let facts: Awaited<ReturnType<typeof gatherDoctorFacts>> | undefined;
    await assert.doesNotReject(async () => {
      facts = await gatherDoctorFacts({
        ...shell,
        readFile: () => {
          throw new Error('EISDIR: illegal operation on a directory, read');
        },
      });
    });
    assert.equal(facts?.configUnreadable, 'EISDIR: illegal operation on a directory, read');
    assert.equal(facts !== undefined && 'config' in facts, false);
  });
});

describe('gatherDoctorFacts: the recipe files (ADR 0053)', () => {
  it("keeps the Brewery's recipe and brewer files, when it can read them", async () => {
    const { shell } = fakeShell();
    const brewery = {
      recipes: [{ path: 'recipes/pale.jsonc', text: '{}' }],
      brewers: [{ path: 'brewers/maltster.md', unreadable: 'EACCES' }],
    };
    const facts = await gatherDoctorFacts({ ...shell, readBrewery: () => brewery });
    assert.deepEqual(facts.brewery, brewery);
    // Without a way to read them, it has none.
    assert.equal('brewery' in (await gatherDoctorFacts(shell)), false);
  });
});
