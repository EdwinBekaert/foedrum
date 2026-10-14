// JSON frontmatter (ADR 0007): a JSON object between `---` lines at the top of a Markdown file.

import { parseJsonc } from './jsonc.ts';

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split('\n');
  const close = lines.indexOf('---', 1);
  return {
    data: parseJsonc(lines.slice(1, close).join('\n')) as Record<string, unknown>,
    body: lines.slice(close + 1).join('\n'),
  };
}
