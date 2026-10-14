// JSONC reader (ADR 0007): JSON with comments and trailing commas.

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripComments(text));
}

// Comments become spaces (line breaks kept) so positions in the result match the input.
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) {
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

const blank = (s: string): string => s.replace(/[^\r\n]/g, ' ');
