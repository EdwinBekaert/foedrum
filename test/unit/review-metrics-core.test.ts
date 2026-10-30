// node scripts/review-metrics.ts (#673): the /brew-review summary comments of merged pull requests,
// read back. The fixtures are summaries posted on Foedrum's own pull requests, trimmed: each table
// cell cut, and the stages other than the lens findings dropped. `no-table.md` is #509's summary
// with its findings table taken out.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  aggregate,
  type Finding,
  formatMetrics,
  isSummary,
  type PullRequest,
  parseSummary,
  type Summary,
} from '../../scripts/review-metrics/core.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'review-metrics');
const text = (name: string): string => readFileSync(join(fixtures, name), 'utf8');

const withFindings = (summary: Summary): Extract<Summary, { kind: 'findings' }> => {
  assert.equal(summary.kind, 'findings');
  return summary as Extract<Summary, { kind: 'findings' }>;
};
const rowOf = (summary: Summary, row: string): Finding =>
  withFindings(summary).findings.find((finding) => finding.row === row) ?? assert.fail(row);

describe('isSummary', () => {
  it('takes a comment whose first line is a review heading, and no other', () => {
    assert.equal(isSummary(text('template.md')), true);
    assert.equal(isSummary(text('no-lens-section.md')), true);
    assert.equal(isSummary(`\r\n${text('template.md').replace(/\n/g, '\r\n')}`), true);
    assert.equal(isSummary('## Merge? A change @ 93f5eaa\n\n## Review: `x` @ `1`\n'), false);
    assert.equal(isSummary('Seen again in the review of #298.'), false);
  });
});

describe('parseSummary', () => {
  it("reads the template's table: lens without its round mark, severity, and how each ended", () => {
    const summary = withFindings(parseSummary(text('template.md')));
    assert.equal(summary.head, '93f5eaad');
    assert.equal(summary.findings.length, 13);
    assert.deepStrictEqual(summary.unread, []);
    assert.deepStrictEqual(rowOf(summary, '1'), {
      row: '1',
      lenses: ['acceptance'],
      severity: 'minor',
      preExisting: false,
      end: 'dismissed',
    });
    assert.equal(rowOf(summary, '3').end, 'fixed');
    assert.equal(rowOf(summary, '8').severity, 'major');
    // "first recorded in ADR 0262 …": neither fixed nor dismissed.
    assert.equal(rowOf(summary, '2').end, 'other');
    assert.deepStrictEqual(rowOf(summary, '12').lenses, ['design-conformance']);
    assert.deepStrictEqual(rowOf(summary, '13').lenses, ['design-conformance', 'test-design']);
    assert.equal(summary.mismatch, undefined);
  });

  it('takes the highest round the lens cells or the text before the mutation check state', () => {
    assert.equal(withFindings(parseSummary(text('template.md'))).rounds, 4);
    assert.equal(withFindings(parseSummary(text('rounds-in-prose.md'))).rounds, 2);
    // Brett's "round 1: … · round 2: …" are the mutation check's, not lens rounds.
    assert.equal(withFindings(parseSummary(text('second-summary.md'))).rounds, undefined);
  });

  it('reads a count of tests passed or run as no round (#627: "815 pass", #554: "10 pass")', () => {
    const body = text('template.md').replace(
      '13 findings: 0 blocker',
      'The check: 815 pass, and 10 runs of the demo. 13 findings: 0 blocker',
    );
    assert.equal(withFindings(parseSummary(body)).rounds, 4);
  });

  it('reads a severity marked pre-existing, a row of several lenses, and a lens that is a stage', () => {
    const prose = parseSummary(text('rounds-in-prose.md'));
    assert.equal(withFindings(prose).findings.length, 14);
    assert.deepStrictEqual(rowOf(prose, '8'), {
      row: '8',
      lenses: ['design-conformance'],
      severity: 'minor',
      preExisting: true,
      end: 'fixed',
    });
    const several = parseSummary(text('several-lenses.md'));
    assert.deepStrictEqual(rowOf(several, '1'), {
      row: '1',
      lenses: ['red proof'],
      severity: 'blocker',
      preExisting: false,
      end: 'dismissed',
    });
    assert.deepStrictEqual(rowOf(several, '2').lenses, ['correctness', 'design-conformance']);
    assert.deepStrictEqual(rowOf(several, '5').lenses, ['test-design', 'acceptance']);
    assert.deepStrictEqual(rowOf(several, '11').lenses, ['correctness']);
    assert.equal(rowOf(several, '12').preExisting, true);
    assert.equal(rowOf(several, '15').end, 'dismissed');
  });

  it('ends a dismissed finding marked pre-existing as pre-existing', () => {
    const body = text('several-lenses.md').replaceAll(
      'fixed in `293db23f`: this change made the page incomplete',
      'dismissed because pre-existing, filed as #600',
    );
    assert.equal(rowOf(parseSummary(body), '12').end, 'pre-existing');
    assert.equal(rowOf(parseSummary(body), '13').end, 'pre-existing');
    const said = text('template.md').replace(
      '| dismissed: the consultant',
      '| pre-existing: the consultant',
    );
    assert.equal(rowOf(parseSummary(said), '1').end, 'pre-existing');
  });

  it('counts a split disposition apart, and reports a row without one severity instead of counting it', () => {
    const summary = withFindings(parseSummary(text('split-dispositions.md')));
    // "pause.md fixed in …; CLAUDE.md dismissed as …"
    assert.equal(rowOf(summary, '5').end, 'split');
    assert.equal(rowOf(summary, '14').end, 'dismissed');
    assert.equal(rowOf(summary, '12').end, 'dismissed');
    assert.equal(summary.findings.length, 22);
    assert.deepStrictEqual(summary.unread, [{ row: '13', why: 'severity "—"' }]);
    const both = text('template.md').replace(
      '| test-design (r1) | minor |',
      '| test-design (r1) | minor, major |',
    );
    assert.deepStrictEqual(withFindings(parseSummary(both)).unread, [
      { row: '3', why: 'severity "minor, major"' },
    ]);
  });

  it("reads a fix applied in a commit as fixed, and a cell's escaped bar as text", () => {
    const applied = text('template.md').replace(
      '| fixed in `db1f4a52` |',
      '| applied in `db1f4a52` |',
    );
    assert.equal(rowOf(parseSummary(applied), '3').end, 'fixed');
    const second = parseSummary(text('second-summary.md'));
    assert.equal(withFindings(second).findings.length, 3);
    assert.deepStrictEqual(rowOf(second, '18'), {
      row: '18',
      lenses: ['test-design'],
      severity: 'minor',
      preExisting: false,
      end: 'fixed',
    });
  });

  it("notes a count line in the template's form that differs from its table", () => {
    const body = text('template.md').replace('13 findings: 0 blocker', '15 findings: 0 blocker');
    assert.deepStrictEqual(withFindings(parseSummary(body)).mismatch, { stated: 15, rows: 13 });
  });

  it('reads a summary with no findings, one with no lens section, and one it cannot read', () => {
    assert.deepStrictEqual(parseSummary(text('no-findings.md')), {
      kind: 'no-findings',
      head: 'bb00307e',
      rounds: undefined,
    });
    assert.deepStrictEqual(parseSummary(text('no-lens-section.md')), {
      kind: 'no-lens-section',
      head: 'd46b0bd7',
    });
    assert.deepStrictEqual(parseSummary(text('no-table.md')), {
      kind: 'unparseable',
      head: '5b286f87',
      why: 'a lens findings section without a findings table',
    });
  });
});

const comment = (name: string, url: string, hidden = false) => ({ url, body: text(name), hidden });

describe('aggregate', () => {
  it('gives each lens its findings by severity, how they ended and its dismissed findings', () => {
    const metrics = aggregate([
      { number: 669, comments: [comment('template.md', 'u669')] },
      { number: 563, comments: [comment('several-lenses.md', 'u563')] },
    ]);
    const acceptance = metrics.lenses.find(({ name }) => name === 'acceptance') ?? assert.fail();
    // template.md: rows 1 and 5 (both dismissed); several-lenses.md: row 5 (with test-design).
    assert.deepStrictEqual(acceptance, {
      name: 'acceptance',
      findings: 3,
      severity: { blocker: 0, major: 1, minor: 2 },
      ends: { fixed: 1, dismissed: 2, 'pre-existing': 0, split: 0, other: 0 },
    });
    assert.deepStrictEqual(
      metrics.lenses.map(({ name }) => name),
      [
        'acceptance',
        'correctness',
        'cross-platform',
        'design-conformance',
        'red proof',
        'security',
        'test-design',
      ].filter((name) => metrics.lenses.some((lens) => lens.name === name)),
    );
    // A row of two lenses counts once in the total.
    assert.equal(metrics.total.findings, 13 + 16);
    const blocker = metrics.severities.find(({ severity }) => severity === 'blocker');
    assert.deepStrictEqual(blocker, {
      severity: 'blocker',
      findings: 1,
      ends: { fixed: 0, dismissed: 1, 'pre-existing': 0, split: 0, other: 0 },
    });
    assert.deepStrictEqual(metrics.unclear, [{ number: 669, url: 'u669', what: 'row 2: other' }]);
  });

  it("adds a pull request's lens rounds over its summaries, and counts its hidden ones", () => {
    const metrics = aggregate([
      {
        number: 631,
        comments: [
          comment('rounds-in-prose.md', 'a', true),
          { url: 'note', body: 'Not a summary.', hidden: false },
          comment('second-summary.md', 'b'),
        ],
      },
      {
        number: 593,
        comments: [comment('template.md', 'c'), comment('no-lens-section.md', 'd')],
      },
      { number: 639, comments: [comment('no-findings.md', 'e')] },
    ]);
    assert.deepStrictEqual(
      metrics.pulls.map(({ number, summaries, hidden, lensRounds }) => ({
        number,
        summaries,
        hidden,
        lensRounds,
      })),
      [
        // 2 stated, then one more without a number.
        { number: 593, summaries: 2, hidden: 0, lensRounds: 4 },
        { number: 631, summaries: 2, hidden: 1, lensRounds: 3 },
        { number: 639, summaries: 1, hidden: 0, lensRounds: 1 },
      ],
    );
  });

  it('replaces the rounds when a later summary states a higher one, and adds its own when lower', () => {
    const later = (rounds: string) =>
      text('second-summary.md').replace('### Lens findings', `### Lens findings\n\n${rounds}\n`);
    const metrics = aggregate([
      {
        number: 1,
        comments: [
          comment('rounds-in-prose.md', 'a'),
          { url: 'b', body: later('Round 3 reran test-design.'), hidden: false },
        ],
      },
      {
        number: 2,
        comments: [
          comment('rounds-in-prose.md', 'c'),
          { url: 'd', body: later('Round 2 reran test-design.'), hidden: false },
        ],
      },
    ]);
    assert.deepStrictEqual(
      metrics.pulls.map(({ lensRounds }) => lensRounds),
      [3, 4],
    );
  });

  it('reports an unparseable summary and a row it cannot count, and counts neither', () => {
    const metrics = aggregate([
      { number: 509, comments: [comment('no-table.md', 'u509')] },
      { number: 553, comments: [comment('split-dispositions.md', 'u553')] },
      { number: 510, comments: [{ url: 'x', body: 'Thanks.', hidden: false }] },
    ]);
    assert.deepStrictEqual(metrics.unparsed, [
      { number: 509, url: 'u509', what: 'a lens findings section without a findings table' },
    ]);
    assert.deepStrictEqual(metrics.unreadRows, [
      { number: 553, url: 'u553', what: 'row 13: severity "—"' },
    ]);
    assert.equal(metrics.total.findings, 22);
    assert.deepStrictEqual(
      metrics.pulls.map(({ number }) => number),
      [553],
    );
    assert.deepStrictEqual(metrics.withoutSummary, [509, 510]);
  });

  it('notes a count line that differs from its table', () => {
    const body = text('template.md').replace('13 findings: 0 blocker', '15 findings: 0 blocker');
    const metrics = aggregate([{ number: 669, comments: [{ url: 'u', body, hidden: false }] }]);
    assert.deepStrictEqual(metrics.mismatches, [
      { number: 669, url: 'u', what: 'the count line says 15 findings, the table has 13 rows' },
    ]);
  });
});

describe('formatMetrics', () => {
  const pulls: PullRequest[] = [
    { number: 669, comments: [comment('template.md', 'u669')] },
    { number: 509, comments: [comment('no-table.md', 'u509')] },
    { number: 639, comments: [comment('no-findings.md', 'u639', true)] },
  ];

  it('prints a row per lens with its dismissed share, and the total', () => {
    const report = formatMetrics(aggregate(pulls));
    assert.match(
      report,
      /^\| Lens \| Findings \| Blocker \| Major \| Minor \| Fixed \| Dismissed \| Pre-existing \| Split \| Other \| Dismissed share \|$/m,
    );
    // template.md's acceptance rows 1 and 5: both minor, both dismissed.
    assert.match(
      report,
      /^\| acceptance \| 2 \| 0 \| 0 \| 2 \| 0 \| 2 \| 0 \| 0 \| 0 \| 100% \|$/m,
    );
    assert.match(
      report,
      /^\| all findings \| 13 \| 0 \| 1 \| 12 \| 10 \| 2 \| 0 \| 0 \| 1 \| 15% \|$/m,
    );
  });

  it('prints the findings by severity, the rounds, and what the counts leave out', () => {
    const report = formatMetrics(aggregate(pulls));
    assert.match(report, /^\| major \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0% \|$/m);
    assert.match(report, /^2 pull requests with a summary, 2 summaries \(1 hidden\)\.$/m);
    assert.match(
      report,
      /^Lens rounds to pass: mean 2\.5, median 2\.5, most 4 \(1 round: 1, 4 rounds: 1\)\.$/m,
    );
    assert.match(report, /^\| #669 \| 1 \| 0 \| 4 \| 13 \| 10 \| 2 \| 0 \| 0 \| 1 \|$/m);
    assert.match(report, /^- #509 u509: a lens findings section without a findings table$/m);
    assert.match(report, /^- #669 u669: row 2: other$/m);
    assert.match(report, /^Without a summary: #509\.$/m);
  });
});
