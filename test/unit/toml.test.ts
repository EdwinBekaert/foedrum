// The TOML statements the Cargo reader reads (ADR 0320): each key with its table's path, what a
// reader of a few tables must get past, and what it refuses.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotToml, readToml } from '../../src/formats/toml.ts';

const text = (value: string) => ({ kind: 'string', text: value });
const entries = (toml: string) =>
  readToml(toml).map(({ path, value }) => [
    path.join('|'),
    value.kind === 'string' ? value.text : value.kind,
  ]);

describe('the TOML reader', () => {
  it('gives each key with the path of its table, and an inline table key by key', () => {
    assert.deepEqual(
      readToml('top = "a"\n[one.two]\nkey = "b"\n[three]\nin = { x = "c" }\ndot.ted = "d"\n'),
      [
        { path: ['top'], value: text('a') },
        { path: ['one', 'two'], value: { kind: 'table' } },
        { path: ['one', 'two', 'key'], value: text('b') },
        { path: ['three'], value: { kind: 'table' } },
        { path: ['three', 'in'], value: { kind: 'table' } },
        { path: ['three', 'in', 'x'], value: text('c') },
        { path: ['three', 'dot', 'ted'], value: text('d') },
      ],
    );
  });

  it('reads a quoted key of a header, and an array of tables as its table', () => {
    assert.deepEqual(entries(`[target.'cfg(unix)'."a b".deps]\nk = "v"\n[[bin]]\nname = "x"\n`), [
      ['target|cfg(unix)|a b|deps', 'table'],
      ['target|cfg(unix)|a b|deps|k', 'v'],
      ['bin', 'table'],
      ['bin|name', 'x'],
    ]);
  });

  it('gets past a multi-line string or array that holds what looks like a statement', () => {
    const toml = [
      '[package]',
      'description = """',
      '[dependencies]',
      'fake = "1"',
      '"""',
      "note = '''",
      '[dependencies]',
      "'''",
      'authors = [',
      '  "[dependencies]", # a comment',
      '  { name = "x" },',
      ']',
      'name = "real"',
    ].join('\n');
    assert.deepEqual(entries(toml).at(-1), ['package|name', 'real']);
    assert.deepEqual(
      entries(toml).map(([path]) => path),
      ['package', 'package|description', 'package|note', 'package|authors', 'package|name'],
    );
  });

  it('reads a basic string with its escapes and a literal string without them', () => {
    assert.deepEqual(
      entries(String.raw`a = "x\\y\"z\t\u0041\U0001F37A"
b = 'c:\d'
c = """one\
    two"""
d = """e"""""
`),
      [
        ['a', 'x\\y"z\tA\u{1F37A}'],
        ['b', 'c:\\d'],
        ['c', 'onetwo'],
        ['d', 'e""'],
      ],
    );
  });

  it('reads a number, a boolean and a date as other, up to what ends them', () => {
    assert.deepEqual(
      entries('a = 12 # why\nb = true\nc = 1979-05-27\nd = [1, 2]\ne = { f = 3, }'),
      [
        ['a', 'other'],
        ['b', 'other'],
        ['c', 'other'],
        ['d', 'other'],
        ['e', 'table'],
        ['e|f', 'other'],
      ],
    );
  });

  it('reads a BOM and CRLF line ends', () => {
    const bom = String.fromCodePoint(0xfeff);
    assert.deepEqual(entries(`${bom}[a]\r\nb = "c"\r\n`), [
      ['a', 'table'],
      ['a|b', 'c'],
    ]);
  });

  it('refuses each thing that is not TOML, naming its line', () => {
    const cases: [string, RegExp][] = [
      ['a = "b', /an unclosed string on line 1/],
      ['a = """b', /an unclosed string on line 1/],
      ["\na = 'b", /an unclosed string on line 2/],
      ["a = 'b\nc'", /an unclosed string on line 1/],
      ['a = "b\nc"', /an unclosed string on line 1/],
      ["a = '''b", /an unclosed string on line 1/],
      ['a = "\\q"', /an unknown escape on line 1/],
      ['a = "\\u12"', /an unknown escape on line 1/],
      ['a = "\\UFFFFFFFF"', /an unknown escape on line 1/],
      ['a = [1, 2', /an unclosed array on line 1/],
      ['a = { b = 1', /an unclosed inline table on line 1/],
      ['a = [1 2]', /an unclosed array on line 1/],
      ['a = { b = 1 c = 2 }', /an unclosed inline table on line 1/],
      ['a = ', /a key without a value on line 1/],
      ['a "b"', /a key without a value on line 1/],
      ['= "b"', /a key that is empty on line 1/],
      ['a. = "b"', /a key that is empty on line 1/],
      ['[a', /an unclosed table header on line 1/],
      ['[[a]', /an unclosed table header on line 1/],
      ['[a] b', /text after a statement on line 1/],
      ['a = "b" c', /text after a statement on line 1/],
      ['\n\na = 1 2', /text after a statement on line 3/],
    ];
    for (const [toml, reason] of cases) {
      assert.throws(
        () => readToml(toml),
        (error: unknown) => error instanceof NotToml && reason.test(error.message),
        toml,
      );
    }
  });

  it('refuses arrays and inline tables nested past its depth, without a stack overflow', () => {
    assert.throws(
      () => readToml(`a = ${'['.repeat(100_000)}`),
      (error: unknown) =>
        error instanceof NotToml && /nested too deep on line 1/.test(error.message),
    );
    assert.throws(
      () => readToml(`a = ${'{ b = '.repeat(100_000)}`),
      (error: unknown) =>
        error instanceof NotToml && /nested too deep on line 1/.test(error.message),
    );
    assert.deepEqual(entries(`a = ${'['.repeat(32)}${']'.repeat(32)}`), [['a', 'other']]);
  });

  it("reads a multi-line literal string's text, a last comment without a line end, and blanks around a key's dots (regression test)", () => {
    assert.deepEqual(entries("e = '''x'''''\n"), [['e', "x''"]]);
    assert.deepEqual(entries('a = 1 # end'), [['a', 'other']]);
    assert.deepEqual(entries('# only a comment'), []);
    assert.deepEqual(entries('a . b = "c"\n[ x . y ]\n'), [
      ['a|b', 'c'],
      ['x|y', 'table'],
    ]);
  });
});
