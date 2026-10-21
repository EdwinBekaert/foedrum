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

/** A path as git prints it, relative to the checkout's root with `/`. Scaffolding is no instruction. */
export const isAudited = (path: string): boolean =>
  !path.endsWith('/.gitkeep') &&
  AUDITED_PATHS.some((audited) => path === audited || path.startsWith(`${audited}/`));

export const measure = (text: string): Size => {
  const newlines = text.split('\n').length - 1;
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text === '' || text.endsWith('\n') ? newlines : newlines + 1,
  };
};

export const compare = (
  now: Readonly<Record<string, Size>>,
  before?: Readonly<Record<string, Size>>,
): Row[] =>
  [...new Set([...Object.keys(now), ...Object.keys(before ?? {})])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((file) => ({
      file,
      ...(now[file] === undefined ? {} : { now: now[file] }),
      ...(before?.[file] === undefined ? {} : { before: before[file] }),
    }));

const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

const sum = (sizes: readonly (Size | undefined)[]): Size =>
  sizes.reduce<Size>(
    (total, size) => ({
      bytes: total.bytes + (size?.bytes ?? 0),
      lines: total.lines + (size?.lines ?? 0),
    }),
    { bytes: 0, lines: 0 },
  );

const change = (now: Size | undefined, before: Size | undefined): string[] =>
  before === undefined
    ? ['new', 'new']
    : [signed((now?.bytes ?? 0) - before.bytes), signed((now?.lines ?? 0) - before.lines)];

/** One tab-separated line per file, then the total, then the files over a target. */
export const formatReport = (rows: readonly Row[], since?: string): string[] => {
  const columns = (row: Row): string[] => [
    row.now === undefined ? '-' : `${row.now.bytes}`,
    row.now === undefined ? '-' : `${row.now.lines}`,
    ...(since === undefined ? [] : change(row.now, row.before)),
  ];
  const now = sum(rows.map((row) => row.now));
  const before = sum(rows.map((row) => row.before));
  const header = ['file', 'bytes', 'lines'];
  if (since !== undefined) header.push(`bytes since ${since}`, `lines since ${since}`);
  return [
    header.join('\t'),
    ...rows.map((row) => [row.file, ...columns(row)].join('\t')),
    [
      'total',
      `${now.bytes}`,
      `${now.lines}`,
      ...(since === undefined ? [] : change(now, before)),
    ].join('\t'),
    ...rows
      .filter((row) => row.file === 'CLAUDE.md' && (row.now?.lines ?? 0) > CLAUDE_MD_LINE_TARGET)
      .map(
        (row) =>
          `${row.file}: ${row.now?.lines} lines, over the memory docs target of ${CLAUDE_MD_LINE_TARGET}`,
      ),
  ];
};
