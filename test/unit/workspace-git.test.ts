import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gitEnv } from '../../src/workspace/git.ts';

describe('gitEnv', () => {
  it('keeps the environment and turns off every prompt, in the terminal and in a window', () => {
    assert.deepEqual(gitEnv({ PATH: '/bin', GIT_TERMINAL_PROMPT: '1' }), {
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    });
  });

  // An ssh command of its own would override GIT_SSH and core.sshCommand, such as Windows'
  // OpenSSH for the ssh-agent service or plink for Pageant, and the fetch would fail.
  it("leaves the user's ssh choice alone", () => {
    assert.equal(gitEnv({}).GIT_SSH_COMMAND, undefined);
    assert.equal(gitEnv({ GIT_SSH: 'plink.exe' }).GIT_SSH, 'plink.exe');
    assert.equal(gitEnv({ GIT_SSH_COMMAND: 'ssh -i key' }).GIT_SSH_COMMAND, 'ssh -i key');
  });
});
