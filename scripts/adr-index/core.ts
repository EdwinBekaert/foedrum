// The ADR index, rebuilt from the records (issue #312): the table in docs/adr/README.md and the
// "Amended by" / "Superseded by" part of each record's status line, worked out by reversing every
// record's `Amends [NNNN](…)` / `Supersedes [NNNN](…)` links. Pure: file texts in, new texts out;
// scripts/adr-index.ts reads and writes the folder (ADR 0021).

export interface AdrFile {
  /** The file's name in docs/adr/, such as `0024-state-branch.md`. */
  name: string;
  text: string;
}

export type Rebuild =
  | {
      ok: true;
      /** README.md's new text. */
      readme: string;
      /** The records whose text changes, with their new text. */
      records: AdrFile[];
      /** One line per difference, `<file>[:<line>]: <what changes>`; empty when nothing does. */
      changes: string[];
    }
  | { ok: false; problems: string[] };

export const rebuild = (_readme: string, _records: AdrFile[]): Rebuild => {
  throw new Error('not implemented');
};
