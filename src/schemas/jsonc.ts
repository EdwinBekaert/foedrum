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

export function parseJsonc(text: string): unknown {
  return JSON.parse(toJson(stripBom(text)));
}

const stripBom = (text: string): string => (text.startsWith('\uFEFF') ? text.slice(1) : text);

// Comments and trailing commas become spaces (line breaks kept), so positions in the
// result match the input.
function toJson(text: string): string {
  const out: string[] = [];
  let comma = -1; // index in `out` of a comma that may turn out to be trailing
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      const stop = stringEnd(text, i);
      out.push(text.slice(i, stop));
      comma = -1;
      i = stop;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out.push(blank(text.slice(i, stop)));
      i = stop;
    } else if (text.startsWith('/*', i)) {
      const stop = text.indexOf('*/', i + 2) + 2;
      out.push(blank(text.slice(i, stop)));
      i = stop;
    } else {
      if ((c === '}' || c === ']') && comma !== -1) {
        out[comma] = ' ';
      }
      if (c === ',') {
        comma = out.length;
      } else if (!/\s/.test(c)) {
        comma = -1;
      }
      out.push(c);
      i++;
    }
  }
  return out.join('');
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
