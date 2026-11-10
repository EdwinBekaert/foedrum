// The local gate's pre-filter on plain strings (ADR 0056, ADR 0252): which hook inputs and
// commands may need the gate, and how it reads a word the shells' quotes and escapes split. That
// a call it lets go loads nothing past it, at either test, is test/integration/precheck.test.ts's
// two load traces.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  foldQuotes,
  jsonLineBreaks,
  mayNeedTheGate,
  normalised,
} from '../../scripts/precheck/prefilter.ts';

describe('mayNeedTheGate', () => {
  for (const word of ['git', 'gh', 'push', 'merge', 'ready', 'pwsh', 'powershell', 'npx', 'npm']) {
    it(`needs the gate for a text that names ${word}`, () => {
      assert.equal(mayNeedTheGate(`x ${word} y`), true);
    });
  }

  it('needs the gate for dlx, bun and a JSON escape, in any case', () => {
    for (const text of ['pnpm DLX x', 'Bun x', 'GIT push', 'a \\u0067it']) {
      assert.equal(mayNeedTheGate(text), true, text);
    }
  });

  it('needs the gate for a word the shells split with quotes or escapes', () => {
    for (const text of ["gi''t", 'g\\it', 'g`it', 'g^h', 'gi"t', 'g’h', 'g\\\nit', 'g`\r\nh']) {
      assert.equal(mayNeedTheGate(text), true, JSON.stringify(text));
    }
  });

  it('lets go a text that names none of the words', () => {
    assert.equal(mayNeedTheGate('ls -la src'), false);
  });

  it('needs the gate for a delete word only beside a character that computes a path', () => {
    for (const text of ['rm -r $d', 'rd /s %D%', 'ri -r `x`', 'del (x)', 'Remove-Item @o']) {
      assert.equal(mayNeedTheGate(text), true, text);
    }
    assert.equal(mayNeedTheGate('rm -r build'), false);
    assert.equal(mayNeedTheGate('echo $HOME'), false);
  });

  // The raw input of a call whose description names git passes; its command alone does not, so
  // the hook parses it and then lets it go (#152).
  it('reads a description that names git in the raw input, and not in the command', () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la src', description: 'List the files git tracks' },
    });
    assert.equal(mayNeedTheGate(jsonLineBreaks(input)), true);
    assert.equal(mayNeedTheGate('ls -la src'), false);
  });
});

describe('normalised', () => {
  it('drops the quotes and escape characters bash, PowerShell and cmd drop', () => {
    assert.equal(normalised(`g"i't\`x^y\\z`), 'gitxyz');
  });

  it('keeps a backslash before u, for a JSON escape', () => {
    assert.equal(normalised('\\u0067it'), '\\u0067it');
  });

  it('drops a line continuation before the quotes, also before \\r\\n', () => {
    assert.equal(normalised('gi\\\nt pu`\r\nsh g^\nh'), 'git push gh');
  });
});

describe('foldQuotes', () => {
  it('reads typographic quotes as the plain ones, as PowerShell does', () => {
    assert.equal(foldQuotes('‘a’ ‚b‛ “c” „d'), `'a' 'b' "c" "d`);
  });
});

describe('jsonLineBreaks', () => {
  it("decodes JSON's \\n, \\r and \\\\ one escape at a time", () => {
    assert.equal(jsonLineBreaks('a\\nb\\rc\\\\d'), 'a\nb\rc\\d');
    // An escaped backslash before n is a backslash and an n, never a line break.
    assert.equal(jsonLineBreaks('\\\\npx'), '\\npx');
  });

  it('leaves the other escapes as they are', () => {
    assert.equal(jsonLineBreaks('\\t\\u0067'), '\\t\\u0067');
  });
});
