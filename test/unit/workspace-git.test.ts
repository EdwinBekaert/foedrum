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
    assert.ok(
      Object.entries(options?.env ?? {}).some(
        ([key, value]) => key.startsWith('GIT_CONFIG_KEY_') && value === 'user.name',
      ),
    );
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
});
