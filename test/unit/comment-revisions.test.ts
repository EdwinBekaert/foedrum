// The cut every comment Foedrum posts goes through (ADR 0072, ADR 0225, ADR 0233): plain text in,
// nothing reaches GitHub (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cutForComment, longestComment } from '../../src/engine/comment-revisions.ts';

describe('cutForComment', () => {
  const line = `${'a'.repeat(99)}\n`;

  it('keeps a text of exactly the longest a comment may be, and cuts one character more at a line (regression test)', () => {
    const longest = line.repeat(longestComment / line.length);
    assert.equal(longest.length, longestComment);
    assert.equal(cutForComment(longest), longest);
    const cut = cutForComment(`${longest}b`);
    assert.ok(cut.length <= longestComment, String(cut.length));
    assert.ok(
      cut.endsWith('\n\n… the rest is cut: GitHub keeps comments shorter.'),
      cut.slice(-80),
    );
    assert.ok(longest.startsWith(cut.slice(0, cut.indexOf('\n\n…'))));
  });
});
