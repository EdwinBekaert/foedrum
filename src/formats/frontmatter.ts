// JSON frontmatter (ADR 0007): a JSON object between `---` lines at the top of a Markdown file.

import { checkedInput, ParseError, parseErrorAt, parseJsonc } from './jsonc.ts';

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Errors are ParseErrors whose line and column refer to the whole file. The first line that is
 * exactly `---` after the opening one closes the frontmatter, even inside a block comment.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = checkedInput(text).split(/(?<=\n)/); // each line keeps its line break
  if (!isDelimiter(lines[0] ?? '')) {
    throw new ParseError("Expected '---' on the first line", 1, 1);
  }
  const close = lines.findIndex((line, i) => i > 0 && isDelimiter(line));
  if (close === -1) {
    throw new ParseError("No closing '---' line for the frontmatter", 1, 1);
  }
  // A line break stands in for the opening line, so error positions match the file.
  const json = `\n${lines.slice(1, close).join('')}`;
  const data = parseJsonc(json);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    const start = (json.match(leadingBlank)?.[0] ?? '').length;
    throw parseErrorAt(json, start, 'Frontmatter must be a JSON object');
  }
  return { data: data as Record<string, unknown>, body: lines.slice(close + 1).join('') };
}

// Whitespace and comments before the value; the input has already parsed, so comments are closed.
const leadingBlank = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;

const isDelimiter = (line: string): boolean => line.replace(/\r?\n$/, '') === '---';
