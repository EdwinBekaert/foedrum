// JSONC reader (ADR 0007): JSON with comments and trailing commas.

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripComments(text));
}

// Comments become spaces (line breaks kept) so positions in the result match the input.
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const stop = stringEnd(text, i);
      out += text.slice(i, stop);
      i = stop;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (text.startsWith('/*', i)) {
      const stop = text.indexOf('*/', i + 2) + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

// Index just past the string starting at `start`, or the end of the line if it is unterminated.
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
    i += text[i] === '\\' ? 2 : 1;
  }
  return text[i] === '"' ? i + 1 : i;
}

const blank =(s: string): string => s.replace(/[^\r\n]/g, ' ');
