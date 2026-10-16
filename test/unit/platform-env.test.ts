// The user a command that changes state records (ADR 0044): the account's name, or the
// environment's when the account has none (a container's arbitrary uid on Linux).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { userName } from '../../src/platform/env.ts';

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
