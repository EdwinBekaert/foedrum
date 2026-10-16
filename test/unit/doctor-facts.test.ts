// `foedrum doctor`'s shell with a fake PATH and a fake process runner (ADR 0021). The real
// machine is in test/integration/doctor.test.ts.

import assert from 'node:assert/strict';
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
};

// What a fake shell finds on PATH and answers besides the tools above.
interface Extra {
  onPath: Record<string, string>;
  answers: Record<string, ExecResult>;
}

const fakeShell = (extra: Extra = { onPath: {}, answers: {} }) => {
  const calls: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
  const exec: ExecProcess = async (file, args, options) => {
    calls.push({ file, args, options });
    const answer = extra.answers[file] ?? answers[file];
    if (answer === undefined) throw new Error(`unexpected ${file}`);
    return answer;
  };
  const shell: DoctorShell = {
    exec,
    resolve: (name) => extra.onPath[name] ?? onPath[name],
    platform: 'linux',
    kernelRelease: '6.8.0-45-generic',
    node: '24.20.0',
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

  // A runtime waiting for its daemon is the common case (#99: docker.exe on the Windows runner).
  const hangingDocker: Extra = {
    onPath: { docker: '/usr/bin/docker' },
    answers: {
      '/usr/bin/docker': {
        exitCode: null,
        stdout: '',
        stderr: '',
        output: '',
        killed: 'timed-out',
      },
    },
  };

  it('gives a container runtime a shorter deadline than the other tools', async () => {
    const { calls, shell } = fakeShell(hangingDocker);
    await gatherDoctorFacts(shell);
    const docker = calls.find(({ file }) => file === '/usr/bin/docker');
    assert.equal(docker?.options.timeoutMs, 3_000);
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
