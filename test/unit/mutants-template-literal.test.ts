// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are lines of code the check reads
// A Brett mutant inside a JavaScript or TypeScript template literal (ADR 0341): its text and its
// `${}` can be edited, with no new word and no text turned into code, a mutant that breaks the
// literal is refused, and a line the check cannot read with confidence keeps ADR 0034's rule.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mutantCheck } from '../../src/checks/mutants.ts';

const check = (original: string, replacement: string, file = 'web/line.ts', ending = '\n') =>
  mutantCheck(
    { file, line: 2, original, replacement },
    {
      inCode: () => true,
      changed: () => ({
        content: `first();${ending}  ${original}${ending}last();${ending}`,
        added: new Set([2]),
      }),
    },
  );

const reasonOf = (original: string, replacement: string, file?: string): string | undefined => {
  const verdict = check(original, replacement, file);
  return verdict.ok ? undefined : verdict.reason;
};

describe('a line the check cannot read with confidence keeps the rule of ADR 0034', () => {
  it('a backtick inside a regular expression literal opens no template literal', () => {
    assert.equal(
      reasonOf('/`[a-z]`/.test(b);', '/`[z-a]`/.test(b);'),
      'the replacement adds `[z-a]`',
    );
  });

  it('a brace inside a regular expression literal does not end a `${}`', () => {
    const original = '`${a.replace(/}/, b)} c`;';
    const replacement = '`${a.replace(/}/, c)} c`;';
    assert.equal(
      reasonOf(original, replacement),
      `the replacement adds ${replacement.slice(0, -1)}`,
    );
  });

  it("a backtick inside a line comment opens no template literal, and the comment's words stay out", () => {
    assert.equal(
      reasonOf('a > b; // use `c` here', 'a > c; // use `c` here'),
      'the replacement adds c',
    );
  });

  it('a backtick inside a block comment opens no template literal', () => {
    assert.equal(
      reasonOf('a > b; /* use `c` */', 'a > c; /* use `c` */'),
      'the replacement adds c',
    );
  });

  it('a backtick inside a plain string opens no template literal', () => {
    assert.equal(reasonOf("'`' + a;", "'`' + b;"), 'the replacement adds b');
  });

  it('a line that closes a multi-line literal keeps the word rule', () => {
    assert.equal(reasonOf('${a} end`;', '${b} end`;'), 'the replacement adds b');
    assert.equal(reasonOf('${a > b} end`;', '${a >= b} end`;'), undefined);
  });

  it('a line that closes a multi-line literal and opens the next is not read as one literal', () => {
    assert.equal(reasonOf('end`, `start', 'end`; `start'), 'the replacement adds `; `');
  });

  it('a middle line of a multi-line literal keeps the word rule', () => {
    assert.equal(reasonOf('n ${a > b} m', 'n ${a >= b} m'), undefined);
    assert.equal(reasonOf('n ${a > b} m', 'n ${a > c} m'), 'the replacement adds c');
  });
});

describe('what is not a template literal does not change', () => {
  it('a plain string is one string still', () => {
    assert.equal(reasonOf("x('not on tap');", "x('on tap');"), "the replacement adds 'on tap'");
  });

  it('a backtick string of another language is one string still', () => {
    assert.equal(reasonOf('x := `a b`', 'x := `b a`', 'web/line.go'), 'the replacement adds `b a`');
    assert.equal(reasonOf('x = `a b`', 'x = `b a`', 'web/line.py'), 'the replacement adds `b a`');
  });

  it('a change of whitespace alone changes nothing', () => {
    assert.equal(reasonOf('x(`a / b`);', 'x(`a/b`);'), 'the replacement changes nothing');
  });

  it('a mutant may delete a whole line that holds a literal', () => {
    assert.equal(reasonOf('x(`a ${b}`);', ''), undefined);
  });

  it('still needs its original on a line of the file', () => {
    const verdict = mutantCheck(
      { file: 'web/line.ts', line: 1, original: 'x(`n`);', replacement: 'x(`m n`);' },
      {
        inCode: () => true,
        changed: () => ({ content: 'x(`other`);\n', added: new Set([1]) }),
      },
    );
    assert.deepEqual(verdict, { ok: false, reason: 'no line of web/line.ts is the original' });
  });

  it('adds no name outside the literal that the code lacks', () => {
    assert.equal(reasonOf('x(`a b`);', 'a(`a b`);'), 'the replacement adds a');
  });
});
