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

describe('a mutant inside a template literal (ADR 0341)', () => {
  const real = ") => fit(`${frame} ${batchTime} / ${attempts.join(' ; ')}`, columns);";

  for (const [name, ending] of [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ] as const) {
    it(`may change the literal's text, found on its line, in a file of ${name}`, () => {
      const replacement = real.replace(' / ', ' | ');
      const verdict = check(real, replacement, 'web/line.ts', ending);
      assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
      assert.equal(verdict.line, 2);
      assert.equal(verdict.content, `first();${ending}  ${replacement}${ending}last();${ending}`);
    });

    it(`may change an expression in its \${}, found on its line, in a file of ${name}`, () => {
      const replacement = 'x(`n ${a >= b}`);';
      const verdict = check('x(`n ${a > b}`);', replacement, 'web/line.ts', ending);
      assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
      assert.equal(verdict.content, `first();${ending}  ${replacement}${ending}last();${ending}`);
    });
  }

  it('may reorder, drop or change what the text and the expressions already hold', () => {
    const edits: Array<[string, string]> = [
      [real, ") => fit(`${batchTime} ${frame} / ${attempts.join(' ; ')}`, columns);"],
      [real, ") => fit(`${frame} / ${attempts.join(' ; ')}`, columns);"],
      ['x(`not on tap`);', 'x(`on tap`);'],
      ['x(`on tap not`);', 'x(`not on tap`);'],
      ['x(`at 5 of 6`);', 'x(`at 6 of 6`);'],
      ['x(`done: true`);', 'x(`done: false`);'],
      ['x(`a ${b}`);', 'x(`a b`);'],
      ['x(`a ${b}`);', 'x(`a $b}`);'],
      ['x(`\\na`);', 'x(`a`);'],
      ['x(`a\\n`);', 'x(`a\\t`);'],
      ["x(`it's ${a}`, 'y');", "x(`${a} it's`, 'y');"],
    ];
    for (const [original, replacement] of edits) {
      assert.equal(reasonOf(original, replacement), undefined, replacement);
    }
  });

  it('adds no word to the text that the line lacks, so new words stay refused', () => {
    assert.equal(
      reasonOf('x(`tests passed`);', 'x(`tests failed`);'),
      'the replacement adds failed',
    );
    // A word built from a numeric escape is new too, and so is a string's content or a comment's.
    assert.equal(reasonOf('x(`a`);', 'x(`\\x65val`);'), 'the replacement adds \\x65, val');
    assert.equal(reasonOf("x(`a`, 'b');", "x(`b`, 'b');"), 'the replacement adds b');
    assert.equal(reasonOf('x(`a`); // b', 'x(`b`);'), 'the replacement adds b');
  });

  it('reads an escape of a letter as that letter, so it spells no new word', () => {
    assert.equal(
      reasonOf('x(`tests passed`);', 'x(`tests \\d\\i\\e\\d`);'),
      'the replacement adds died',
    );
    assert.equal(reasonOf('x(`a`);', 'x(`\\c\\m\\d`);'), 'the replacement adds cmd');
    assert.equal(reasonOf('x(`url`);', 'x(`\\curl`);'), 'the replacement adds curl');
    // An escape of a word's own letter on the line spells that word, which the line holds.
    assert.equal(reasonOf('x(`cmd a`);', 'x(`a \\c\\m\\d`);'), undefined);
  });

  it('reads a numeric escape whole, in each of its forms, so it spells no new word', () => {
    assert.equal(reasonOf('x(`a`);', 'x(`\\u0065`);'), 'the replacement adds \\u0065');
    assert.equal(reasonOf('x(`a`);', 'x(`\\u{65}`);'), 'the replacement adds \\u{65}');
    assert.equal(reasonOf('x(`u a`);', 'x(`\\u{65} a`);'), 'the replacement adds \\u{65}');
    assert.equal(reasonOf('x(`\\x65 a`);', 'x(`a \\x65`);'), undefined);
  });

  it('reads a replacement with no literal left, so no word of the text becomes code', () => {
    assert.equal(
      reasonOf('alpha(`${`gamma ${beta}`} `);', 'gamma();'),
      'the replacement adds gamma',
    );
    assert.equal(
      reasonOf('alpha(`${`gamma ${beta / 2}`} `);', 'gamma();'),
      'the replacement adds gamma',
    );
    assert.equal(reasonOf('x(`${a}`);', 'x(a);'), undefined);
  });

  it('adds no name or string to an expression that its code lacks', () => {
    assert.equal(reasonOf('x(`n ${a}`);', 'x(`n ${c}`);'), 'the replacement adds c');
    assert.equal(reasonOf("x(`n ${a}`, 'y');", "x(`n ${a}`, 'z');"), "the replacement adds 'z'");
  });

  it('turns no word of the text into code, though the text may take a word of the code', () => {
    assert.equal(reasonOf('x(`eval ${a}`);', 'x(`${eval} a`);'), 'the replacement adds eval');
  });

  it('a mutant that removes an escape cannot turn text into code', () => {
    assert.equal(reasonOf('x(`a \\${eval} b`);', 'x(`a ${eval} b`);'), 'the replacement adds eval');
    assert.equal(
      reasonOf('x(`a\\` + eval + \\`b`);', 'x(`a` + eval + `b`);'),
      'the replacement adds eval',
    );
  });

  it('reads a literal nested in a `${}`, with its text as text', () => {
    const nested = "x(`${a ? `b c` : 'd'} e`);";
    assert.equal(reasonOf(nested, "x(`${a ? `c b` : 'd'} e`);"), undefined);
    assert.equal(reasonOf(nested, "x(`${!a ? `b c` : 'd'} e`);"), undefined);
    assert.equal(reasonOf(nested, "x(`${b ? `b c` : 'd'} e`);"), 'the replacement adds b');
  });

  it("does not read a nested literal's text as code, as the pairs of backticks would", () => {
    assert.equal(
      reasonOf('alpha(`${`\\${gamma} beta ${`beta `} `} \\` beta `);', 'gamma(`beta `);'),
      'the replacement adds gamma',
    );
  });

  it('a line it is not sure of must pass both rules, so a nested literal stays text', () => {
    assert.equal(
      reasonOf('alpha(`${`gamma ${beta / 2}`} `);', 'gamma(`${`gamma ${beta / 2}`} `);'),
      'the replacement adds gamma',
    );
  });

  it("counts a `{` inside a `${}`,so its `}` does not end the expression's code", () => {
    assert.equal(reasonOf('y(`x ${ {a}.a }`);', 'y(`x ${ {a}.x }`);'), 'the replacement adds x');
  });

  it('reads a tagged template as text', () => {
    assert.equal(reasonOf('sql`select a from b`;', 'sql`select b from a`;'), undefined);
    assert.equal(
      reasonOf('sql`select a from b`;', 'sql`drop a from b`;'),
      'the replacement adds drop',
    );
  });

  it('reads the literals of every JavaScript and TypeScript extension, in capitals too', () => {
    for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'TS']) {
      assert.equal(reasonOf('x(`a b`);', 'x(`b a`);', `web/line.${extension}`), undefined);
    }
  });

  it('refuses a replacement that breaks the literal', () => {
    const broken = 'the replacement breaks a template literal';
    assert.equal(reasonOf('x(`/`);', 'x(`/);'), broken);
    assert.equal(reasonOf('x(`n ${a}`);', 'x(`n ${a`);'), broken);
    assert.equal(reasonOf('x(`n ${a}`);', 'x(`n ${a});'), broken);
    assert.equal(reasonOf('x(`n ${a}`);', 'x(`n` ${a}`);'), broken);
    assert.equal(reasonOf('x(`n\\\\`);', 'x(`n\\`);'), broken);
    assert.equal(reasonOf('x(`n \\` m`);', 'x(`n ` m`);'), broken);
  });

  it("refuses a line that gains or loses a multi-line literal's lone backtick", () => {
    const broken = 'the replacement breaks a template literal';
    assert.equal(reasonOf('n m', 'n` m'), broken);
    assert.equal(reasonOf('const a = `n ${b}', 'const a = n ${b}'), broken);
    assert.equal(reasonOf('n ${a}`;', 'n ${a};'), broken);
    assert.equal(reasonOf('const a = `n ${b}', ''), broken);
  });
});
