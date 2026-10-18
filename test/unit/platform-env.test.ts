// The user a command that changes state records (ADR 0044): the account's name, or the
// environment's when the account has none (a container's arbitrary uid on Linux).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { userName, withoutGitHubTokens } from '../../src/platform/env.ts';

const noAccount = (): string => {
  throw new Error('uv_os_get_passwd returned ENOENT (no such file or directory)');
};

describe('userName', () => {
  it("is the account's name", () => {
    assert.equal(
      userName(() => 'ada', { USER: 'grace' }),
      'ada',
    );
  });

  it('falls back to USER, then USERNAME, when the account has no name', () => {
    assert.equal(userName(noAccount, { USER: 'grace', USERNAME: 'linus' }), 'grace');
    assert.equal(userName(noAccount, { USERNAME: 'linus' }), 'linus');
    assert.equal(
      userName(() => ' ', { USER: '', USERNAME: 'linus' }),
      'linus',
    );
  });

  it('is unknown when nothing names the user', () => {
    assert.equal(userName(noAccount, {}), 'unknown');
    assert.equal(userName(noAccount, { USER: '  ' }), 'unknown');
  });
});

// Foedrum reaches GitHub only through gh's own login (ADR 0073): gh prefers a token variable to
// it, also when git asks gh for a credential.
describe('withoutGitHubTokens', () => {
  const tokens = {
    GH_TOKEN: 'a',
    GITHUB_TOKEN: 'b',
    GH_ENTERPRISE_TOKEN: 'c',
    GITHUB_ENTERPRISE_TOKEN: 'd',
  };

  it('removes the four token variables and keeps everything else', () => {
    const env = withoutGitHubTokens({ PATH: '/bin', GH_HOST: 'github.com', ...tokens }, 'linux');
    assert.deepEqual(env, { PATH: '/bin', GH_HOST: 'github.com' });
  });

  it('compares names as the platform does', () => {
    const mixed = { Gh_Token: 'a', github_token: 'b', Path: 'C:\bin' };
    assert.deepEqual(withoutGitHubTokens(mixed, 'win32'), { Path: 'C:\bin' });
    assert.deepEqual(withoutGitHubTokens(mixed, 'linux'), mixed);
  });

  it('leaves the environment it is given as it was', () => {
    const env = { PATH: '/bin', ...tokens };
    withoutGitHubTokens(env, 'linux');
    assert.deepEqual(env, { PATH: '/bin', ...tokens });
  });
});
