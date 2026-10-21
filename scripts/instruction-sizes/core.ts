// The pure part of `node scripts/instruction-sizes.ts` (issue #280): which files are Foedrum's own
// instructions, how big each one is, and the report against an earlier commit. The shell
// (instruction-sizes.ts) reads the files through git (ADR 0021).

/** The audited set: what every session and brewer reads (issue #280). */
export const AUDITED_PATHS = ['CLAUDE.md', '.claude/skills', '.claude/agents', 'defaults'] as const;

/** The memory docs' target for one CLAUDE.md file. */
export const CLAUDE_MD_LINE_TARGET = 200;

export interface Size {
  bytes: number;
  lines: number;
}

/** One file of the report: its size now, at the earlier commit, or both. */
export interface Row {
  file: string;
  now?: Size;
  before?: Size;
}

export const isAudited = (_path: string): boolean => {
  throw new Error('not implemented');
};

export const measure = (_text: string): Size => {
  throw new Error('not implemented');
};

export const compare = (
  _now: Readonly<Record<string, Size>>,
  _before?: Readonly<Record<string, Size>>,
): Row[] => {
  throw new Error('not implemented');
};

export const formatReport = (_rows: readonly Row[], _since?: string): string[] => {
  throw new Error('not implemented');
};
