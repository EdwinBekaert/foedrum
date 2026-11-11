// What a brewer or an issue wrote, as GitHub shows it as itself (ADR 0072, ADR 0379): escapes only
// where GitHub would read Markdown, and a word that would mention someone as a code span, so the raw
// text a person reads on a terminal or in an email reads as the rendered one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plain, plainWithin } from '../../src/engine/status-comment.ts';

describe('plainWithin', () => {
  it('shows ! as itself: an image needs the [ after it, which stays escaped', () => {
    assert.equal(plain('Stop! ![x](y)'), 'Stop! !\\[x\\](y)');
  });

  it('shows a word that would mention someone as a code span, never &#64;', () => {
    assert.equal(plain('ask @alice about @demo/greet.'), 'ask `@alice` about `@demo/greet`.');
    assert.equal(plain('@team-a, then'), '`@team-a`, then');
    assert.doesNotMatch(plain('@alice'), /&#64;/);
  });

  it("leaves a name's trailing -, / or . outside its code span: regression test", () => {
    assert.equal(plain('@alice-, @org/ x @bob.'), '`@alice`-, `@org`/ x `@bob`.');
  });

  it('keeps an @ that starts no login as it is', () => {
    assert.equal(plain('a @ b, @@, @_x, @'), 'a @ b, @@, @\\_x, @');
  });

  it('a code span takes only the characters of a name, so the rest is escaped as before', () => {
    assert.equal(plain('@alice_*x* <b>'), '`@alice_`\\*x\\* &lt;b&gt;');
  });

  it('never cuts a code span in half: one past the limit goes whole', () => {
    assert.equal(plainWithin('ab @alice', 8), 'ab …');
    assert.equal(plainWithin('ab @alice', 11), 'ab `@alice`');
  });
});
