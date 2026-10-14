// JSONC reader (ADR 0007): JSON with comments and trailing commas.

/** Malformed input; `line` and `column` are 1-based and point at the offending character. */
export class ParseError extends SyntaxError {
  readonly line: number;
  readonly column: number;

  constructor(reason: string, line: number, column: number) {
    super(`${reason} at line ${line}, column ${column}`);
    this.name = 'ParseError';
    this.line = line;
    this.column = column;
  }
}

/** Parses JSONC, ignoring a leading BOM; throws a ParseError at the first syntax error. */
export function parseJsonc(text: string): unknown {
  const json = toJson(checkedInput(text));
  try {
    return JSON.parse(json);
  } catch (error) {
    locateError(json);
    throw error;
  }
}

/** The text without a leading BOM; throws a ParseError if it is longer than maxInputLength. */
export function checkedInput(text: string): string {
  const source = stripBom(text);
  if (source.length > maxInputLength) {
    throw parseErrorAt(
      source,
      maxInputLength,
      `Input too large (more than ${maxInputLength} characters)`,
    );
  }
  return source;
}

const stripBom = (text: string): string => (text.startsWith('\uFEFF') ? text.slice(1) : text);

// Input may come from untrusted repositories; the limit also bounds locateError's recursion.
const maxDepth = 64;

/** Longest accepted input in characters (1 MiB), not counting a BOM. */
export const maxInputLength = 1_048_576;

// Comments and trailing commas become spaces (line breaks kept), so positions in the
// result match the input.
function toJson(text: string): string {
  const out: string[] = [];
  let comma = -1; // index in `out` of a comma that may turn out to be trailing
  let last = ''; // last character outside comments and whitespace
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      const stop = stringEnd(text, i);
      out.push(text.slice(i, stop));
      comma = -1;
      last = c;
      i = stop;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out.push(blank(text.slice(i, stop)));
      i = stop;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        throw parseErrorAt(text, i, 'Unterminated block comment');
      }
      out.push(blank(text.slice(i, end + 2)));
      i = end + 2;
    } else {
      if (c === '{' || c === '[') {
        depth++;
        if (depth > maxDepth) {
          throw parseErrorAt(text, i, `Too deeply nested (more than ${maxDepth} levels)`);
        }
      } else if (c === '}' || c === ']') {
        depth = Math.max(0, depth - 1);
        if (comma !== -1) out[comma] = ' ';
      }
      if (!isWhitespace(c)) {
        // A comma right after '[', '{' or another comma is not trailing; JSON.parse rejects it.
        comma = c === ',' && !'[{,'.includes(last) ? out.length : -1;
        last = c;
      }
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

// Throws a ParseError at the first syntax error in `json` (comments and trailing commas
// already blanked out). Runs only after JSON.parse rejected the input, whose messages do not
// always carry a position.
function locateError(json: string): void {
  let i = 0;
  const fail = (reason: string): never => {
    throw parseErrorAt(json, i, i < json.length ? reason : 'Unexpected end of input');
  };
  const skipWhitespace = (): void => {
    while (i < json.length && isWhitespace(json[i] as string)) i++;
  };
  const scalar = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const escapeSequence = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;

  const string = (): void => {
    i++;
    while (json[i] !== '"') {
      const c = json[i];
      if (c === undefined || c === '\n' || c === '\r') fail('Unterminated string');
      if (c === '\\') {
        escapeSequence.lastIndex = i;
        if (!escapeSequence.test(json)) fail('Invalid escape in string');
        i = escapeSequence.lastIndex;
      } else if ((c as string) < ' ') {
        fail('Control character in string');
      } else {
        i++;
      }
    }
    i++;
  };

  // Elements of an array or members of an object, after the opening bracket.
  const items = (close: string, item: () => void): void => {
    skipWhitespace();
    if (json[i] === close) {
      i++;
      return;
    }
    for (;;) {
      item();
      skipWhitespace();
      if (json[i] === close) {
        i++;
        return;
      }
      if (json[i] !== ',') fail(`Expected ',' or '${close}'`);
      i++;
    }
  };

  const member = (): void => {
    skipWhitespace();
    if (json[i] !== '"') fail('Expected a property name');
    string();
    skipWhitespace();
    if (json[i] !== ':') fail("Expected ':' after a property name");
    i++;
    value();
  };

  const value = (): void => {
    skipWhitespace();
    const c = json[i];
    if (c === '{') {
      i++;
      items('}', member);
    } else if (c === '[') {
      i++;
      items(']', value);
    } else if (c === '"') {
      string();
    } else {
      scalar.lastIndex = i;
      if (!scalar.test(json)) fail('Expected a value');
      i = scalar.lastIndex;
    }
  };

  value();
  skipWhitespace();
  if (i < json.length) fail('Unexpected content after the value');
}

/** A ParseError at `offset` in `text`; lines are counted by LF, so CRLF counts once. */
export function parseErrorAt(text: string, offset: number, reason: string): ParseError {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return new ParseError(reason, before.split('\n').length, offset - lineStart + 1);
}

// Index just past the string starting at `start`, or the end of the line if it is unterminated.
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
    i += text[i] === '\\' ? 2 : 1;
  }
  return text[i] === '"' ? i + 1 : i;
}

const blank = (s: string): string => s.replace(/[^\r\n]/g, ' ');

// JSON whitespace only: JSON.parse rejects anything else, such as a no-break space.
const isWhitespace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
