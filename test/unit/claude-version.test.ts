// The claude versions the settings proof of ADR 0046 ran against (#128, ADR 0048): outside them,
// doctor and the runner warn that a user's settings may widen a brewer.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isProvenClaude,
  PROVEN_CLAUDE,
  unprovenClaudeWarning,
} from '../../src/brewers/claude-version.ts';

describe('isProvenClaude', () => {
  it('holds for the version the proof ran against', () => {
    assert.deepEqual(PROVEN_CLAUDE, { from: '2.1.301', to: '2.1.301' });
    assert.equal(isProvenClaude('2.1.301'), true);
  });

  it('does not hold for a version before or after the range', () => {
    for (const version of ['2.1.300', '2.1.302', '2.2.0', '1.9.999', '10.0.0', '2.1.301.1']) {
      assert.equal(isProvenClaude(version), false, version);
    }
  });

  it('compares the parts as numbers, not as text', () => {
    const range = { from: '2.1.9', to: '2.1.10' };
    assert.equal(isProvenClaude('2.1.10', range), true);
    assert.equal(isProvenClaude('2.1.9', range), true);
    assert.equal(isProvenClaude('2.1.11', range), false);
    assert.equal(isProvenClaude('2.1.8', range), false);
  });

  it('does not hold for what is not a version', () => {
    for (const version of ['', 'latest', '2.1', '2.1.x', ' 2.1.301', '2.1.301-beta']) {
      assert.equal(isProvenClaude(version), false, JSON.stringify(version));
    }
  });
});

describe('unprovenClaudeWarning', () => {
  it('says nothing for a proven version', () => {
    assert.equal(unprovenClaudeWarning('2.1.301'), undefined);
  });

  it('names the version, the proven range and what may happen', () => {
    assert.equal(
      unprovenClaudeWarning('2.2.0'),
      'claude 2.2.0 is not a version Foedrum proved its brewer settings on (2.1.301): a permissions.allow or env in your Claude Code user settings may widen what a brewer may do (ADR 0046)',
    );
  });
});
