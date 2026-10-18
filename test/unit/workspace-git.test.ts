import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import { gitEnv, runGitWith } from '../../src/workspace/git.ts';

describe('gitEnv', () => {
  it('keeps the environment and turns off every prompt, in the terminal and in a window', () => {
    const env = gitEnv({ PATH: '/bin', GIT_TERMINAL_PROMPT: '1' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GCM_INTERACTIVE, 'never');
  });

  // Out docs on the state branch can be deep; Windows git refuses paths over 260 characters.
  it('turns on long paths through the environment, after any configuration already there', () => {
    const fresh = gitEnv({});
    assert.equal(fresh.GIT_CONFIG_COUNT, '1');
    assert.equal(fresh.GIT_CONFIG_KEY_0, 'core.longpaths');
    assert.equal(fresh.GIT_CONFIG_VALUE_0, 'true');

    const given = gitEnv({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: '1',
      GIT_CONFIG_KEY_1: 'c.d',
      GIT_CONFIG_VALUE_1: '2',
    });
    assert.equal(given.GIT_CONFIG_COUNT, '3');
    assert.equal(given.GIT_CONFIG_KEY_0, 'a.b');
    assert.equal(given.GIT_CONFIG_KEY_1, 'c.d');
    assert.equal(given.GIT_CONFIG_KEY_2, 'core.longpaths');
    assert.equal(given.GIT_CONFIG_VALUE_2, 'true');
  });

  it("adds a call's own configuration after long paths", () => {
    const env = gitEnv({}, { 'core.hooksPath': '/work/no-hooks', 'x.y': 'z' });
    assert.equal(env.GIT_CONFIG_COUNT, '3');
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.longpaths');
    assert.equal(env.GIT_CONFIG_KEY_1, 'core.hooksPath');
    assert.equal(env.GIT_CONFIG_VALUE_1, '/work/no-hooks');
    assert.equal(env.GIT_CONFIG_KEY_2, 'x.y');
    assert.equal(env.GIT_CONFIG_VALUE_2, 'z');
  });

  // An ssh command of its own would override GIT_SSH and core.sshCommand, such as Windows'
  // OpenSSH for the ssh-agent service or plink for Pageant, and the fetch would fail.
  it("leaves the user's ssh choice alone", () => {
    assert.equal(gitEnv({}).GIT_SSH_COMMAND, undefined);
    assert.equal(gitEnv({ GIT_SSH: 'plink.exe' }).GIT_SSH, 'plink.exe');
    assert.equal(gitEnv({ GIT_SSH_COMMAND: 'ssh -i key' }).GIT_SSH_COMMAND, 'ssh -i key');
  });

  // gh auth git-credential answers with a token variable before gh's own login (ADR 0073).
  it('removes the GitHub token variables, so git gets the credential of gh login', () => {
    const env = gitEnv(
      { PATH: '/bin', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c' },
      {},
      'linux',
    );
    assert.equal(env.PATH, '/bin');
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
      assert.equal(name in env, false, name);
    }
    assert.equal('gh_token' in gitEnv({ gh_token: 'a' }, {}, 'win32'), false);
  });
});

describe('runGitWith', () => {
  const answering = (result: ExecResult) => {
    const calls: Parameters<ExecProcess>[] = [];
    const exec: ExecProcess = async (...call) => {
      calls.push(call);
      return result;
    };
    return { calls, git: runGitWith(exec) };
  };
  const exited = (exitCode: number, stdout = '', stderr = ''): ExecResult => ({
    exitCode,
    stdout,
    stderr,
    output: stdout + stderr,
  });

  it("runs git in the directory, in git's environment, with a 60 s deadline by default", async () => {
    const { calls, git } = answering(exited(0));
    await git('/work/repo', ['status', '--porcelain']);
    const [file, args, options] = calls[0] ?? [];
    assert.equal(file, 'git');
    assert.deepEqual(args, ['status', '--porcelain']);
    assert.equal(options?.cwd, '/work/repo');
    assert.equal(options?.timeoutMs, 60_000);
    assert.equal(options?.env?.GIT_TERMINAL_PROMPT, '0');
  });

  it("passes the call's deadline and configuration on", async () => {
    const { calls, git } = answering(exited(0));
    await git('/work/repo', ['commit'], { timeoutMs: 5, config: { 'user.name': 'Brewer' } });
    const options = calls[0]?.[2];
    assert.equal(options?.timeoutMs, 5);
    assert.deepEqual(options?.env, gitEnv(process.env, { 'user.name': 'Brewer' }));
  });

  // A command whose output grows with the data, such as ls-tree over the state branch (#91).
  it("passes the call's output limit on, and names it when git passes it", async () => {
    const limit = 256 * 1024 * 1024;
    const { calls, git } = answering({
      exitCode: null,
      stdout: '100644 blob',
      stderr: '',
      output: '100644 blob',
      killed: 'too-much-output',
    });
    const result = await git('/work/repo', ['ls-tree', '-r'], { maxOutputBytes: limit });
    assert.equal(calls[0]?.[2].maxOutputBytes, limit);
    assert.equal(result.stderr, 'git wrote more than 256 MiB of output');
  });

  it("passes the call's stop signal on", async () => {
    const { calls, git } = answering(exited(0));
    const stop = new AbortController();
    await git('/work/repo', ['fetch'], { signal: stop.signal });
    assert.equal(calls[0]?.[2].signal, stop.signal);
  });

  it("answers with git's exit code and output", async () => {
    const { git } = answering(exited(128, 'out', 'fatal: no\n'));
    assert.deepEqual(await git('/work/repo', ['status']), {
      code: 128,
      stdout: 'out',
      stderr: 'fatal: no\n',
    });
  });

  it('answers without an exit code, saying so, when git was killed at its deadline', async () => {
    const { git } = answering({
      exitCode: null,
      stdout: '',
      stderr: 'remote: ',
      output: 'remote: ',
      killed: 'timed-out',
    });
    assert.deepEqual(await git('/work/repo', ['fetch'], { timeoutMs: 5 }), {
      code: null,
      stdout: '',
      stderr: 'remote: git timed out after 5 ms',
    });
  });

  // A diff of untrusted content, or a hook that writes without end (#91).
  it('answers without an exit code, saying so, when git wrote more than the output limit', async () => {
    const { git } = answering({
      exitCode: null,
      stdout: 'diff --git',
      stderr: '',
      output: 'diff --git',
      killed: 'too-much-output',
    });
    assert.deepEqual(await git('/work/repo', ['log', '-p']), {
      code: null,
      stdout: 'diff --git',
      stderr: 'git wrote more than 4 MiB of output',
    });
  });
});
