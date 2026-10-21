// `node scripts/adr-index.ts [--check]`: rebuilds the table in docs/adr/README.md and the
// "Amended by" / "Superseded by" part of each record's status line from the records (issue #312).
// adr-index/core.ts decides; this shell reads and writes docs/adr/ (ADR 0021). With --check it
// writes nothing and exits 1 naming what differs.

export interface RunDeps {
  /** The names of the files in docs/adr/. */
  list: () => string[];
  /** A file's text, by its name in docs/adr/. */
  readFile: (name: string) => string;
  writeFile: (name: string, text: string) => void;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const run = (_args: string[], _deps: RunDeps): number => {
  throw new Error('not implemented');
};
