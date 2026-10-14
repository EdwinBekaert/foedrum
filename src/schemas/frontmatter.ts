// JSON frontmatter (ADR 0007): a JSON object between `---` lines at the top of a Markdown file.

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(_text: string): Frontmatter {
  throw new Error('not implemented');
}
