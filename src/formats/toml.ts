// A small reader of TOML's statements for the manifests Foedrum reads (ADR 0320): each key with the
// path of its table and its value, a string's text and nothing of any other value. It reads every
// string, array and inline table, so what looks like a statement inside one is never read as one,
// and it refuses what is not TOML; it checks nothing a reader of a few tables does not need, such as
// a key given twice. Repository content, so untrusted input. Pure.

export class NotToml extends Error {}

export type TomlValue = { kind: 'string'; text: string } | { kind: 'table' } | { kind: 'other' };

export interface TomlEntry {
  path: readonly string[];
  value: TomlValue;
}

const MAX_DEPTH = 64;
const BOM = String.fromCodePoint(0xfeff);
const BARE_KEY = /^[\w-]$/;
const ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\x1b',
  '"': '"',
  '\\': '\\',
};

/** Every statement of `text`, in order, an inline table's keys after the table; throws `NotToml`. */
export const readToml = (text: string): TomlEntry[] => {
  const entries: TomlEntry[] = [];
  let at = text.startsWith(BOM) ? 1 : 0;

  const fail = (what: string, where = at): never => {
    throw new NotToml(`${what} on line ${text.slice(0, where).split('\n').length}`);
  };
  const skipSpaces = (): void => {
    while (text[at] === ' ' || text[at] === '\t') at += 1;
  };
  const skipComment = (): void => {
    if (text[at] !== '#') return;
    const end = text.indexOf('\n', at);
    at = end === -1 ? text.length : end;
  };
  const skipBlank = (): void => {
    for (;;) {
      const start = at;
      skipSpaces();
      skipComment();
      while (text[at] === '\n' || text[at] === '\r') at += 1;
      if (at === start) return;
    }
  };
  const endStatement = (): void => {
    skipSpaces();
    skipComment();
    if (at < text.length && text[at] !== '\n' && text[at] !== '\r') {
      fail('text after a statement');
    }
  };

  const escaped = (start: number): string => {
    const code = text[at + 1] ?? '';
    const width = code === 'u' ? 4 : code === 'U' ? 8 : 0;
    if (width === 0) {
      const known = ESCAPES[code];
      if (known === undefined) return fail('an unknown escape', start);
      at += 2;
      return known;
    }
    const hex = text.slice(at + 2, at + 2 + width);
    const point = Number.parseInt(hex, 16);
    if (hex.length !== width || !/^[\da-f]+$/i.test(hex) || point > 0x10ffff) {
      return fail('an unknown escape', start);
    }
    at += 2 + width;
    return String.fromCodePoint(point);
  };
  /** At a `\` that ends a line of a multi-line string: past the blank that follows it, if so. */
  const lineEndingEscape = (): boolean => {
    let next = at + 1;
    while (text[next] === ' ' || text[next] === '\t') next += 1;
    if (text[next] !== '\n' && text[next] !== '\r') return false;
    while (' \t\r\n'.includes(text[next] ?? 'x')) next += 1;
    at = next;
    return true;
  };

  const basicString = (start: number, close: '"' | '"""'): string => {
    const multi = close === '"""';
    let out = '';
    for (;;) {
      const char = text[at];
      if (char === undefined || (!multi && (char === '\n' || char === '\r'))) {
        return fail('an unclosed string', start);
      }
      if (text.startsWith(close, at)) {
        at += close.length;
        while (multi && text[at] === '"') {
          out += '"';
          at += 1;
        }
        return out;
      }
      if (char !== '\\') {
        out += char;
        at += 1;
      } else if (!multi || !lineEndingEscape()) {
        out += escaped(start);
      }
    }
  };
  const literalString = (start: number, close: "'" | "'''"): string => {
    const multi = close === "'''";
    const end = text.indexOf(close, at);
    const line = text.slice(at, end);
    if (end === -1 || (!multi && (line.includes('\n') || line.includes('\r')))) {
      return fail('an unclosed string', start);
    }
    at = end + close.length;
    while (multi && text[at] === "'") at += 1;
    return multi ? text.slice(start + close.length, at - close.length) : line;
  };
  /** The string at `at`, a quote. */
  const string = (): string => {
    const start = at;
    const quote = text[at] === '"' ? '"' : "'";
    if (text.startsWith(quote.repeat(3), at)) {
      at += 3;
      return quote === '"' ? basicString(start, '"""') : literalString(start, "'''");
    }
    at += 1;
    return quote === '"' ? basicString(start, '"') : literalString(start, "'");
  };

  /** A dotted key: its parts, with blanks around its dots. */
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      if (text[at] === '"' || text[at] === "'") {
        parts.push(string());
      } else {
        const start = at;
        while (BARE_KEY.test(text[at] ?? '')) at += 1;
        if (at === start) return fail('a key that is empty');
        parts.push(text.slice(start, at));
      }
      skipSpaces();
      if (text[at] !== '.') return parts;
      at += 1;
    }
  };

  /** The value at `at` of the key `path`, recorded unless it lies in an array. */
  const value = (path: readonly string[] | undefined, depth: number): void => {
    if (depth > MAX_DEPTH) fail('nested too deep');
    const char = text[at];
    if (char === '"' || char === "'") {
      const read = string();
      if (path !== undefined) entries.push({ path, value: { kind: 'string', text: read } });
    } else if (char === '[') {
      const start = at;
      at += 1;
      if (path !== undefined) entries.push({ path, value: { kind: 'other' } });
      for (;;) {
        skipBlank();
        if (text[at] === ']') break;
        if (at >= text.length) fail('an unclosed array', start);
        value(undefined, depth + 1);
        skipBlank();
        if (text[at] === ',') at += 1;
        else if (text[at] !== ']') fail('an unclosed array', start);
      }
      at += 1;
    } else if (char === '{') {
      const start = at;
      at += 1;
      if (path !== undefined) entries.push({ path, value: { kind: 'table' } });
      for (;;) {
        skipBlank();
        if (text[at] === '}') break;
        if (at >= text.length) fail('an unclosed inline table', start);
        const parts = key();
        assignment(path === undefined ? undefined : [...path, ...parts], depth + 1);
        skipBlank();
        if (text[at] === ',') at += 1;
        else if (text[at] !== '}') fail('an unclosed inline table', start);
      }
      at += 1;
    } else {
      const start = at;
      while (at < text.length && !' \t\r\n,]}#'.includes(text[at] ?? '')) at += 1;
      if (at === start) fail('a key without a value');
      if (path !== undefined) entries.push({ path, value: { kind: 'other' } });
    }
  };
  /** The `= value` after a key. */
  const assignment = (path: readonly string[] | undefined, depth: number): void => {
    skipSpaces();
    if (text[at] !== '=') fail('a key without a value');
    at += 1;
    skipSpaces();
    value(path, depth);
  };

  const header = (): string[] => {
    const close = text[at + 1] === '[' ? ']]' : ']';
    at += close.length;
    const parts = key();
    if (!text.startsWith(close, at)) fail('an unclosed table header');
    at += close.length;
    return parts;
  };

  let table: string[] = [];
  for (;;) {
    skipBlank();
    if (at >= text.length) return entries;
    if (text[at] === '[') {
      table = header();
      entries.push({ path: table, value: { kind: 'table' } });
    } else {
      assignment([...table, ...key()], 0);
    }
    endStatement();
  }
};
