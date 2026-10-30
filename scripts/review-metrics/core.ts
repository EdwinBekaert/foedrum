// The pure part of `node scripts/review-metrics.ts` (#673): reads the /brew-review summary comments
// of merged pull requests (`.claude/skills/brew-review/summary-template.md`) and counts their lens
// findings by lens, severity and disposition, and their rounds. The shell (review-metrics.ts) reads
// the comments through gh (ADR 0021). It measures; nothing fails on what it finds.

export type Severity = 'blocker' | 'major' | 'minor';

/**
 * How a finding ended, from its Disposition cell: `split` when one part was fixed and another
 * dismissed, `other` when the cell says neither.
 */
export type End = 'fixed' | 'dismissed' | 'pre-existing' | 'split' | 'other';

export interface Finding {
  /** The row's `#`. */
  row: string;
  /** The lenses the row names, without a round mark. */
  lenses: readonly string[];
  severity: Severity;
  /** The Severity cell marks it as there before the change. */
  preExisting: boolean;
  end: End;
}

/** A row of a findings table that cannot be counted, and why. */
export interface UnreadRow {
  row: string;
  why: string;
}

export type Summary =
  | {
      kind: 'findings';
      head: string;
      findings: readonly Finding[];
      unread: readonly UnreadRow[];
      /** The highest lens round the summary states, if it states one. */
      rounds: number | undefined;
      /** The count line's total, when it is in the template's form and differs from the rows. */
      mismatch?: { stated: number; rows: number };
    }
  | { kind: 'no-findings'; head: string; rounds: number | undefined }
  | { kind: 'no-lens-section'; head: string }
  | { kind: 'unparseable'; head: string; why: string };

const linesOf = (body: string): string[] =>
  body.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim().split('\n');

/** A comment that is a /brew-review summary: its first line is `## Review: …`. */
export const isSummary = (body: string): boolean => /^## Review: /.test(linesOf(body)[0] ?? '');

// A table row's cells, without the outer bars; `\|` stays inside its cell.
const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

const SEVERITIES: readonly Severity[] = ['blocker', 'major', 'minor'];
const ENDS: readonly End[] = ['fixed', 'dismissed', 'pre-existing', 'split', 'other'];

const CARDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const CARDINAL = `(\\d+|${CARDINALS.join('|')})`;
// "Round 2", "round two", "(r3)", "second round", "2nd pass", "four rounds"; never "815 pass" or
// "10 runs", which count tests.
const ROUND_FORMS = [
  new RegExp(`\\brounds? ${CARDINAL}\\b`, 'gi'),
  /\(r(\d+)\b/gi,
  new RegExp(`\\b(${ORDINALS.join('|')}|\\d+(?:st|nd|rd|th)) (?:round|pass|run)\\b`, 'gi'),
  new RegExp(`\\b${CARDINAL} rounds\\b`, 'gi'),
];

const numberOf = (word: string): number => {
  const lower = word.toLowerCase();
  const named = Math.max(CARDINALS.indexOf(lower), ORDINALS.indexOf(lower));
  return named >= 0 ? named + 1 : Number.parseInt(lower, 10);
};

/** The highest round `text` states, if it states one. */
const statedRound = (text: string): number | undefined => {
  const found = ROUND_FORMS.flatMap((form) =>
    [...text.matchAll(form)].map((match) => numberOf(match[1] ?? '')),
  ).filter((n) => Number.isInteger(n) && n > 0);
  return found.length === 0 ? undefined : Math.max(...found);
};

// The lenses a Lens cell names: a round mark or a note in parentheses dropped, then split on
// ",", "and" and "+". A `(` inside a match ends it, so a cell of unclosed `(` is read in linear
// time: a comment by anyone can look like a summary.
const lensesOf = (cell: string): string[] =>
  cell
    .replace(/\([^()]*\)/g, '')
    .split(/,|\band\b|\+/)
    .map((lens) => lens.trim())
    .filter((lens) => lens !== '');

const endOf = (disposition: string, preExisting: boolean): End => {
  const text = disposition.toLowerCase().replace(/^[*_\s]+/, '');
  const dismissed = (): End =>
    preExisting || /^dismissed\W+(?:because\s+)?pre-existing/.test(text)
      ? 'pre-existing'
      : 'dismissed';
  const fixed = /\b(?:fixed|applied)\b/.test(text);
  const isDismissed = /\bdismissed\b/.test(text);
  // A dismissal's reason may say what was fixed elsewhere; a fix that goes on to dismiss the
  // rest is split.
  if (/^(?:fixed|applied)\b/.test(text)) return isDismissed ? 'split' : 'fixed';
  if (/^dismissed\b/.test(text)) return dismissed();
  if (/^pre-existing\b/.test(text)) return 'pre-existing';
  if (fixed && isDismissed) return 'split';
  if (fixed) return 'fixed';
  if (isDismissed) return dismissed();
  return 'other';
};

const isFindingsHeader = (cells: readonly string[]): boolean =>
  ['lens', 'severity', 'disposition'].every((name) =>
    cells.some((cell) => cell.toLowerCase() === name),
  );

/** The rows of every findings table in `lines`: a header with Lens, Severity and Disposition. */
const findingsRows = (
  lines: readonly string[],
): { tables: number; rows: Record<string, string>[] } => {
  const rows: Record<string, string>[] = [];
  let tables = 0;
  for (let at = 0; at < lines.length; at += 1) {
    const header = cellsOf(lines[at] ?? '');
    if (!(lines[at] ?? '').trim().startsWith('|') || !isFindingsHeader(header)) continue;
    tables += 1;
    const names = header.map((cell) => cell.toLowerCase());
    // The separator row follows the header.
    at += 2;
    for (; at < lines.length && (lines[at] ?? '').trim().startsWith('|'); at += 1) {
      const cells = cellsOf(lines[at] ?? '');
      rows.push(Object.fromEntries(names.map((name, i) => [name, cells[i] ?? ''])));
    }
  }
  return { tables, rows };
};

export const parseSummary = (body: string): Summary => {
  const lines = linesOf(body);
  const head = /@ `([0-9a-f]+)`/.exec(lines[0] ?? '')?.[1] ?? '';
  const firstSection = lines.findIndex((line) => line.startsWith('### '));
  const start = lines.findIndex((line) => /^### Lens findings\b/i.test(line));
  const end = lines.findIndex((line, at) => at > start && /^#{2,3} /.test(line));
  const lensSection = start < 0 ? [] : lines.slice(start, end < 0 ? undefined : end);
  const preamble = lines.slice(0, firstSection < 0 ? undefined : firstSection);
  const rounds = statedRound([...preamble, ...lensSection].join('\n'));
  const { tables, rows } = findingsRows(lines);
  if (tables === 0) {
    if (start < 0) return { kind: 'no-lens-section', head };
    if (lensSection.some((line) => /\bno (?:new )?findings\b/i.test(line))) {
      return { kind: 'no-findings', head, rounds };
    }
    return { kind: 'unparseable', head, why: 'a lens findings section without a findings table' };
  }
  const findings: Finding[] = [];
  const unread: UnreadRow[] = [];
  for (const cells of rows) {
    const row = cells['#'] ?? '';
    const severityCell = cells.severity ?? '';
    const named = new Set(
      [...severityCell.toLowerCase().matchAll(/\b(blocker|major|minor)\b/g)].map(([word]) => word),
    );
    const [severity] = named;
    if (named.size !== 1 || severity === undefined) {
      unread.push({ row, why: `severity "${severityCell}"` });
      continue;
    }
    const preExisting = /pre-existing|introduced: false/i.test(severityCell);
    findings.push({
      row,
      lenses: lensesOf(cells.lens ?? ''),
      severity: severity as Severity,
      preExisting,
      end: endOf(cells.disposition ?? '', preExisting),
    });
  }
  const count = lensSection
    .map((line) => /^(\d+) findings?: \d+ blocker/.exec(line)?.[1])
    .find((stated) => stated !== undefined);
  const stated = count === undefined ? undefined : Number(count);
  return {
    kind: 'findings',
    head,
    findings,
    unread,
    rounds,
    ...(stated === undefined || stated === rows.length
      ? {}
      : { mismatch: { stated, rows: rows.length } }),
  };
};

export interface Comment {
  url: string;
  body: string;
  /** Minimized on GitHub. */
  hidden: boolean;
  /** Its author's association with the repository, as GitHub gives it (`OWNER`, `NONE`, …). */
  association?: string | undefined;
}

/** A merged pull request and its comments, in the order they were posted. */
export interface PullRequest {
  number: number;
  comments: readonly Comment[];
}

/** Findings by severity and by how they ended. */
export interface Counts {
  findings: number;
  severity: Record<Severity, number>;
  ends: Record<End, number>;
}

export interface PullMetrics {
  number: number;
  /** Its summary comments, hidden ones included, but not the unparseable ones. */
  summaries: number;
  hidden: number;
  /** The lens rounds its summaries add up to: the rounds it took to pass. */
  lensRounds: number;
  counts: Counts;
}

/** Something the counts leave out, or a note on them, with the comment it is in. */
export interface Left {
  number: number;
  url: string;
  what: string;
}

export interface Metrics {
  /** Each lens a row names, by name. */
  lenses: readonly (Counts & { name: string })[];
  /** Every finding once. */
  total: Counts;
  /** Every finding once, by severity, with how they ended. */
  severities: readonly { severity: Severity; findings: number; ends: Record<End, number> }[];
  /** Each pull request with a summary it could read, by number. */
  pulls: readonly PullMetrics[];
  /** The pull requests without a summary it could read. */
  withoutSummary: readonly number[];
  /** Comments not counted at all. */
  unparsed: readonly Left[];
  /** Rows not counted. */
  unreadRows: readonly Left[];
  /** Rows counted as `split` or `other`. */
  unclear: readonly Left[];
  /** Count lines that differ from their table. */
  mismatches: readonly Left[];
}

// The summaries count only from someone with write access: anyone can comment on a public pull
// request, and a comment headed like a summary would skew the counts.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const summaryOf = ({ body, association }: Comment): Summary => {
  const summary = parseSummary(body);
  if (association !== undefined && TRUSTED.has(association)) return summary;
  const by = association === undefined ? 'an author GitHub did not name' : association;
  return {
    kind: 'unparseable',
    head: summary.head,
    why: `posted by ${by}, not by an owner, member or collaborator`,
  };
};

const noCounts = (): Counts => ({
  findings: 0,
  severity: { blocker: 0, major: 0, minor: 0 },
  ends: { fixed: 0, dismissed: 0, 'pre-existing': 0, split: 0, other: 0 },
});

const add = (counts: Counts, { severity, end }: Finding): void => {
  counts.findings += 1;
  counts.severity[severity] += 1;
  counts.ends[end] += 1;
};

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The counts over `pulls`. A row of several lenses counts once for each of them, and once in the
 * total. A pull request's lens rounds add up over its summaries: a summary's own is the highest
 * round it states, else 1; a later one that states a higher round than the count so far replaces
 * it, as when it goes on numbering, and one that states none or a lower one adds its own. A summary
 * without a lens section adds none.
 */
export const aggregate = (pulls: readonly PullRequest[]): Metrics => {
  const lenses = new Map<string, Counts>();
  const total = noCounts();
  const bySeverity: Record<Severity, Counts> = {
    blocker: noCounts(),
    major: noCounts(),
    minor: noCounts(),
  };
  const counted: PullMetrics[] = [];
  const withoutSummary: number[] = [];
  const unparsed: Left[] = [];
  const unreadRows: Left[] = [];
  const unclear: Left[] = [];
  const mismatches: Left[] = [];
  for (const { number, comments } of [...pulls].sort((a, b) => a.number - b.number)) {
    const pull: PullMetrics = {
      number,
      summaries: 0,
      hidden: 0,
      lensRounds: 0,
      counts: noCounts(),
    };
    const parsed = comments
      .filter(({ body }) => isSummary(body))
      .map((each) => ({ ...each, summary: summaryOf(each) }));
    // One summary per head: a summary posted again for a head replaces the one before it.
    const replaced = (at: number, head: string): boolean =>
      head !== '' &&
      parsed
        .slice(at + 1)
        .some(({ summary }) => summary.kind !== 'unparseable' && summary.head === head);
    for (const [at, { url, hidden, summary }] of parsed.entries()) {
      if (summary.kind !== 'unparseable' && replaced(at, summary.head)) continue;
      if (summary.kind === 'unparseable') {
        unparsed.push({ number, url, what: summary.why });
        continue;
      }
      pull.summaries += 1;
      if (hidden) pull.hidden += 1;
      if (summary.kind === 'no-lens-section') continue;
      const stated = summary.rounds ?? 1;
      pull.lensRounds = stated > pull.lensRounds ? stated : pull.lensRounds + stated;
      if (summary.kind === 'no-findings') continue;
      for (const { row, why } of summary.unread)
        unreadRows.push({ number, url, what: `row ${row}: ${why}` });
      if (summary.mismatch !== undefined) {
        const { stated: says, rows } = summary.mismatch;
        mismatches.push({
          number,
          url,
          what: `the count line says ${says} findings, the table has ${rows} rows`,
        });
      }
      for (const finding of summary.findings) {
        add(total, finding);
        add(bySeverity[finding.severity], finding);
        add(pull.counts, finding);
        for (const lens of new Set(finding.lenses)) {
          const each = lenses.get(lens) ?? noCounts();
          lenses.set(lens, each);
          add(each, finding);
        }
        if (finding.end === 'split' || finding.end === 'other') {
          unclear.push({ number, url, what: `row ${finding.row}: ${finding.end}` });
        }
      }
    }
    if (pull.summaries === 0) withoutSummary.push(number);
    else counted.push(pull);
  }
  return {
    lenses: [...lenses]
      .sort(([a], [b]) => byName(a, b))
      .map(([name, counts]) => ({ name, ...counts })),
    total,
    severities: SEVERITIES.map((severity) => {
      const { findings, ends } = bySeverity[severity];
      return { severity, findings, ends };
    }),
    pulls: counted,
    withoutSummary,
    unparsed,
    unreadRows,
    unclear,
    mismatches,
  };
};

const share = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${Math.round((100 * part) / whole)}%`;

const tableRow = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;

const table = (
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string[] => [tableRow(header), tableRow(header.map(() => '---')), ...rows.map(tableRow)];

const endCells = (ends: Record<End, number>): number[] => ENDS.map((end) => ends[end]);

// Comment text as the report prints it: a control or format character, or a bar, as ?, and at most
// 80 characters. Any commenter's text reaches it, and it goes to a terminal or a model.
const printable = (text: string): string => {
  const safe = text.replace(/[\p{Cc}\p{Cf}|]/gu, '?');
  return safe.length > 80 ? `${safe.slice(0, 80)} …` : safe;
};

const lensCells = (name: string, { findings, severity, ends }: Counts): (string | number)[] => [
  printable(name),
  findings,
  ...SEVERITIES.map((each) => severity[each]),
  ...endCells(ends),
  share(ends.dismissed, findings),
];

const tenths = (n: number): string => String(Math.round(n * 10) / 10);

const median = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

// "mean 2.5, median 2.5, most 4"
const spread = (values: readonly number[]): string => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
  return `mean ${tenths(mean)}, median ${tenths(median(sorted))}, most ${sorted.at(-1) ?? 0}`;
};

// "1 round: 10, 2 rounds: 5"
const distribution = (values: readonly number[]): string => {
  const times = new Map<number, number>();
  for (const n of values) times.set(n, (times.get(n) ?? 0) + 1);
  return [...times]
    .sort(([a], [b]) => a - b)
    .map(([n, count]) => `${n} ${n === 1 ? 'round' : 'rounds'}: ${count}`)
    .join(', ');
};

const leftLines = (title: string, left: readonly Left[]): string[] => [
  `### ${title}`,
  '',
  ...(left.length === 0
    ? ['None.']
    : left.map(({ number, url, what }) => `- #${number} ${url}: ${printable(what)}`)),
  '',
];

/** The report, in Markdown. */
export const formatMetrics = (metrics: Metrics): string => {
  const { lenses, total, severities, pulls } = metrics;
  const summaries = pulls.reduce((sum, pull) => sum + pull.summaries, 0);
  const hidden = pulls.reduce((sum, pull) => sum + pull.hidden, 0);
  // A pull request no lens reviewed took no rounds to pass.
  const rounds = pulls.map(({ lensRounds }) => lensRounds).filter((n) => n > 0);
  const lines = [
    '### Findings by lens',
    '',
    ...table(
      [
        'Lens',
        'Findings',
        'Blocker',
        'Major',
        'Minor',
        'Fixed',
        'Dismissed',
        'Pre-existing',
        'Split',
        'Other',
        'Dismissed share',
      ],
      [...lenses.map((lens) => lensCells(lens.name, lens)), lensCells('all findings', total)],
    ),
    '',
    'A row that names several lenses counts once for each of them, and once in all findings.',
    '',
    '### Findings by severity',
    '',
    ...table(
      [
        'Severity',
        'Findings',
        'Fixed',
        'Dismissed',
        'Pre-existing',
        'Split',
        'Other',
        'Dismissed share',
      ],
      severities.map(({ severity, findings, ends }) => [
        severity,
        findings,
        ...endCells(ends),
        share(ends.dismissed, findings),
      ]),
    ),
    '',
    '### Rounds',
    '',
    ...(pulls.length === 0
      ? ['No pull request with a summary.']
      : [
          `${pulls.length} pull ${pulls.length === 1 ? 'request' : 'requests'} with a summary, ${summaries} ${summaries === 1 ? 'summary' : 'summaries'} (${hidden} hidden).`,
          `Summaries per pull request: ${spread(pulls.map((pull) => pull.summaries))}.`,
          rounds.length === 0
            ? 'Lens rounds to pass: no pull request a lens reviewed.'
            : `Lens rounds to pass: ${spread(rounds)} (${distribution(rounds)}).`,
          '',
          ...table(
            [
              'Pull request',
              'Summaries',
              'Hidden',
              'Lens rounds',
              'Findings',
              'Blocker',
              'Major',
              'Minor',
              'Fixed',
              'Dismissed',
              'Pre-existing',
              'Split',
              'Other',
            ],
            pulls.map((pull) => [
              `#${pull.number}`,
              pull.summaries,
              pull.hidden,
              pull.lensRounds,
              pull.counts.findings,
              ...SEVERITIES.map((severity) => pull.counts.severity[severity]),
              ...endCells(pull.counts.ends),
            ]),
          ),
        ]),
    '',
    ...leftLines('Summaries not counted', metrics.unparsed),
    ...leftLines('Rows not counted', metrics.unreadRows),
    ...leftLines('Rows counted as split or other', metrics.unclear),
    ...leftLines('Count lines that differ from their table', metrics.mismatches),
    ...(metrics.withoutSummary.length === 0
      ? []
      : [`Without a summary: ${metrics.withoutSummary.map((n) => `#${n}`).join(', ')}.`, '']),
  ];
  return lines.join('\n');
};
