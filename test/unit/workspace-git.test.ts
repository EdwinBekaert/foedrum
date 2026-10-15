import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gitEnv } from '../../src/workspace/git.ts';

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
