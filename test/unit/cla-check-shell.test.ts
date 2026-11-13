// The CLA check's shell with a fake file reader (ADR 0391, ADR 0021): what it reads from the
// environment the CI job sets and from the signatures file. The decisions are in
// cla-check-core.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runClaCheck } from '../../scripts/cla-check.ts';

const env = { CLA_AUTHOR: 'alice', CLA_OWNER: 'maintainer-login' };
const signed = (path: string): string | undefined =>
  path === '.github/cla-signatures.md' ? '- @alice, CLA 1.0, 2026-11-20\n' : undefined;

describe('runClaCheck', () => {
  it('reads the author and the owner from the environment and the signatures file', () => {
    assert.equal(runClaCheck(env, signed).ok, true);
  });

  it('fails a signer when the signatures file is missing', () => {
    assert.equal(runClaCheck(env, () => undefined).ok, false);
  });

  it('says the signatures file could not be read instead of that the author did not sign', () => {
    assert.deepEqual(runClaCheck(env, () => undefined), {
      ok: false,
      line: ".github/cla-signatures.md could not be read at the pull request's head",
    });
  });

  it('fails without an author or an owner in the environment', () => {
    for (const missing of [{ CLA_OWNER: 'maintainer-login' }, { CLA_AUTHOR: 'alice' }]) {
      const verdict = runClaCheck(missing, signed);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.line, 'CLA_AUTHOR and CLA_OWNER must be set by the CI job');
    }
  });
});
