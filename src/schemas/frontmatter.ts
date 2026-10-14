// JSON frontmatter (ADR 0007): a JSON object between `---` lines at the top of a Markdown file.

import { parseJsonc, stripBom } from './jsonc.ts';

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const lines = stripBom(text).split(/(?<=\n)/); // each line keeps its line break
  const close = lines.findIndex((line, i) => i > 0 && isDelimiter(line));
  return {
    data: parseJsonc(lines.slice(1, close).join('')) as Record<string, unknown>,
    body: lines.slice(close + 1).join(''),
  };
}

const isDelimiter = (line: string): boolean => line.replace(/\r?\n$/, '') === '---';
