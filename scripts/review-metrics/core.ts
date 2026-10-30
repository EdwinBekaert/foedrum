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

/** A comment that is a /brew-review summary: its first line is `## Review: …`. */
export const isSummary = (_body: string): boolean => {
  throw new Error('not implemented');
};

export const parseSummary = (_body: string): Summary => {
  throw new Error('not implemented');
};

export interface Comment {
  url: string;
  body: string;
  /** Minimized on GitHub. */
  hidden: boolean;
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
  /** Each pull request with a summary, by number. */
  pulls: readonly PullMetrics[];
  /** The pull requests without a summary comment. */
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

export const aggregate = (_pulls: readonly PullRequest[]): Metrics => {
  throw new Error('not implemented');
};

/** The report, in Markdown. */
export const formatMetrics = (_metrics: Metrics): string => {
  throw new Error('not implemented');
};
