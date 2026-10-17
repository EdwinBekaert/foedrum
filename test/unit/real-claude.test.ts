import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REAL_CLAUDE, realClaude } from '../helpers/real-claude.ts';

// A PATH that has `claude`, and one that has not.
const found = (name: string) => (name === 'claude' ? '/usr/local/bin/claude' : undefined);
const missing = () => undefined;

describe('realClaude', () => {
  it('runs the tests with the claude on PATH when FOEDRUM_REAL_CLAUDE=1', () => {
    assert.deepEqual(realClaude({ [REAL_CLAUDE]: '1' }, found), {
      kind: 'run',
      claude: '/usr/local/bin/claude',
    });
  });

  it('skips them when the variable is not set, even with claude on PATH', () => {
    const real = realClaude({}, found);
    assert.equal(real.kind, 'skip');
    assert.match(real.kind === 'skip' ? real.reason : '', /FOEDRUM_REAL_CLAUDE=1/);
  });

  it('skips them when the variable is set to anything but 1', () => {
    for (const value of ['', '0', 'true', 'yes', ' 1']) {
      assert.equal(realClaude({ [REAL_CLAUDE]: value }, found).kind, 'skip', value);
    }
  });

  it('fails when opted in without claude on PATH, instead of skipping', () => {
    assert.throws(
      () => realClaude({ [REAL_CLAUDE]: '1' }, missing),
      /FOEDRUM_REAL_CLAUDE=1.*claude/,
    );
  });
});
