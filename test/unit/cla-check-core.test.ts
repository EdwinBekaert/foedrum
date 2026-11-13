// The CLA check on plain data (ADR 0391, ADR 0021): the author, the repository owner and the
// signatures file's text. The shell is in cla-check-shell.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claCheck } from '../../scripts/cla-check/core.ts';

const owner = 'maintainer-login';
const signatures = [
  '# CLA signatures',
  '',
  'One line per signer.',
  '',
  '- @alice-dev, CLA 1.0, 2026-11-20',
  '- @bobby, CLA 1.0, 2026-11-21',
  '',
].join('\n');

describe('claCheck', () => {
  it('passes an author who has a line in the signatures file', () => {
    assert.equal(claCheck('alice-dev', owner, signatures).ok, true);
  });

  it('fails an author with no line, with one line that says how to sign', () => {
    const verdict = claCheck('carol', owner, signatures);
    assert.equal(verdict.ok, false);
    assert.equal(
      verdict.line,
      '@carol has not signed the CLA: read CLA.md, then add the line ' +
        '"- @carol, CLA 1.0, <YYYY-MM-DD>" to .github/cla-signatures.md in a commit of its own ' +
        'in this pull request.',
    );
  });

  it('passes the repository owner without a line', () => {
    assert.equal(claCheck(owner, owner, '').ok, true);
  });

  it('passes Dependabot without a line', () => {
    assert.equal(claCheck('dependabot[bot]', owner, '').ok, true);
  });

  it('does not count a login that only matches part of a line', () => {
    assert.equal(claCheck('bob', owner, signatures).ok, false);
    assert.equal(claCheck('alice', owner, signatures).ok, false);
    assert.equal(claCheck('dev', owner, signatures).ok, false);
  });

  it('does not count a login mentioned outside a signature line', () => {
    const text = 'Ask @carol to sign.\n  - @carol, CLA 1.0, 2026-11-20\n- @carol signed\n';
    assert.equal(claCheck('carol', owner, text).ok, false);
  });

  it('does not count a line without the version or the date', () => {
    for (const line of [
      '- @carol, CLA 1.0',
      '- @carol, CLA one, 2026-11-20',
      '- @carol, 2026-11-20',
      '- @carol, CLA 1.0, 20 November 2026',
      '- @carol, CLA 1.0, 2026-11-20 and more',
      '- carol, CLA 1.0, 2026-11-20',
    ]) {
      assert.equal(claCheck('carol', owner, `${line}\n`).ok, false, line);
    }
  });

  it('compares logins without regard to case, as GitHub does', () => {
    assert.equal(claCheck('Alice-Dev', owner, signatures).ok, true);
    assert.equal(claCheck('Maintainer-Login', owner, '').ok, true);
    assert.equal(claCheck('Dependabot[bot]', owner, '').ok, true);
  });

  it('counts a signature of any CLA version', () => {
    assert.equal(claCheck('carol', owner, '- @carol, CLA 2.1, 2026-11-20\n').ok, true);
  });

  it('counts a signature line with trailing whitespace', () => {
    assert.equal(claCheck('carol', owner, '- @carol, CLA 1.0, 2026-11-20 \t\n').ok, true);
  });

  it('reads a signatures file with CRLF line ends', () => {
    assert.equal(claCheck('bobby', owner, signatures.replaceAll('\n', '\r\n')).ok, true);
  });
});
