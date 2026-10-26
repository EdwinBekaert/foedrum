// `foedrum lenses` (ADR 0221): per lens over the folded events, its findings by severity and by how
// they ended, and its tokens, each step's lens from the recipe its batch chose, as the files are now.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recipesRun } from '../../src/cli/brewer-report.ts';
import {
  formatLensReport,
  type LensReport,
  type LensSource,
  type LensTally,
  lensReport,
  lensSource,
} from '../../src/cli/lens-report.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event, RecordedFindings, Usage } from '../../src/schemas/events.ts';
import type { Disposition, TastingFinding } from '../../src/schemas/out-doc.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';

const deadlineAt = '2026-10-26T10:00:00.000Z';
const usage = (input: number, output: number, read: number, write: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheWriteTokens: write,
});
const zero = usage(0, 0, 0, 0);

// nip: implement (the Cellarman), correctness (a blocking lens step routed back to implement) and
// acceptance (an advisory one). The recipe `old` is gone; diff/security is in use and never ran.
const source: LensSource = {
  lenses: [
    { name: 'diff/acceptance', path: 'defaults/lenses/diff/acceptance.md' },
    { name: 'diff/correctness', path: 'defaults/lenses/diff/correctness.md' },
    { name: 'diff/security', path: 'lenses/diff/security.md' },
  ],
  step: (recipe, stepId) => {
    if (recipe !== 'nip') return undefined;
    if (stepId === 'correctness') return { lens: 'diff/correctness' };
    if (stepId === 'acceptance') return { lens: 'diff/acceptance' };
    if (stepId === 'implement') return { lens: undefined };
    return undefined;
  },
};
const report = (events: readonly Event[], from = source): LensReport =>
  lensReport(fold(events), from, recipesRun(events));
const lens = (made: LensReport, name: string): LensTally | undefined => {
  const found = made.lenses.find((each) => each.name === name);
  if (found === undefined) return undefined;
  const { name: _, path: __, ...tally } = found;
  return tally;
};
const tally = (counts: Partial<LensTally> = {}): LensTally => ({
  rounds: 0,
  severity: { blocker: 0, major: 0, minor: 0 },
  ends: { fixed: 0, dismissed: 0, 'pre-existing': 0, open: 0 },
  notRecorded: { rounds: 0, findings: 0 },
  usage: zero,
  ...counts,
});

/** A finding at a file and line: what an out doc holds, as JSON. */
type Found = TastingFinding & { file: string; line: number };
const finding = (
  file: string,
  line: number,
  severity: TastingFinding['severity'] = 'major',
  introduced = true,
): Found => ({ file, line, severity, why: `why ${file}:${line}`, introduced });

const ordered = (batchId: string, issue: number, recipe = 'nip'): Event[] => [
  { type: 'batch.ordered', batchId, order: { issue }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId, recipe, reason: 'label', source: 'label' },
];

type Outcome = Extract<Event, { type: 'step.finished' }>['outcome'];
interface Ran {
  usage?: Usage;
  findings?: RecordedFindings;
  /** The step whose findings route scheduled it. */
  from?: string;
}
const attempt = (
  batchId: string,
  stepId: string,
  n: number,
  outcome: Outcome,
  ran: Ran = {},
): Event[] => [
  {
    type: 'step.scheduled',
    batchId,
    stepId,
    attempt: n,
    deadlineAt,
    ...(ran.from === undefined ? {} : { route: { from: ran.from, why: 'findings' } }),
  },
  { type: 'step.started', batchId, stepId, attempt: n },
  {
    type: 'step.finished',
    batchId,
    stepId,
    attempt: n,
    outcome,
    ...(ran.usage === undefined ? {} : { usage: ran.usage }),
    ...(ran.findings === undefined ? {} : { findings: ran.findings }),
  },
];
/** A Taster's success: advisory, or approving. */
const tasted = (findings: Found[]): Outcome => ({
  kind: 'succeeded',
  output: {
    status: 'done',
    summary: 'tasted',
    assumptions: [],
    verdict: findings.some(({ severity, introduced }) => introduced && severity !== 'minor')
      ? 'changes'
      : 'approve',
    findings,
  },
});
/** A blocking Taster's `changes`, as `finish` records it. */
const blocked: Outcome = {
  kind: 'failed',
  retryable: false,
  reason: 'blocked (findings): the Taster asks for changes: fix it',
};
const kept = (...findings: TastingFinding[]): RecordedFindings => ({ kept: findings, more: 0 });
/** The Cellarman's success with its dispositions. */
const disposed = (...dispositions: Disposition[]): Outcome => ({
  kind: 'succeeded',
  output: { status: 'done', summary: 'fixed', assumptions: [], dispositions },
});
const implemented: Outcome = disposed();

describe('lensReport', () => {
  it('counts the findings of a lens by severity and by how they ended, and its tokens', () => {
    const events = [
      ...ordered('b1', 1),
      ...attempt('b1', 'implement', 1, implemented),
      ...attempt('b1', 'correctness', 1, blocked, {
        usage: usage(10, 20, 30, 40),
        findings: kept(
          finding('src/a.ts', 1, 'blocker'),
          finding('src/b.ts', 2),
          finding('src/c.ts', 3, 'minor'),
          finding('src/d.ts', 4),
        ),
      }),
      ...attempt(
        'b1',
        'implement',
        2,
        disposed(
          { file: 'src/a.ts', line: 1, disposition: 'fixed' },
          { file: 'src/b.ts', line: 2, disposition: 'dismissed', why: 'tested in a.test.ts:3' },
          { file: 'src/c.ts', line: 3, disposition: 'pre-existing', why: 'main has it at c.ts:3' },
        ),
        { from: 'correctness' },
      ),
      ...attempt('b1', 'correctness', 2, tasted([]), { usage: usage(1, 2, 3, 4) }),
    ];
    assert.deepStrictEqual(
      lens(report(events), 'diff/correctness'),
      tally({
        rounds: 2,
        severity: { blocker: 1, major: 2, minor: 1 },
        ends: { fixed: 1, dismissed: 1, 'pre-existing': 1, open: 1 },
        usage: usage(11, 22, 33, 44),
      }),
    );
  });

  it("sums a lens's tokens over every attempt of its steps, also one that did not review", () => {
    const events = [
      ...ordered('b1', 1),
      ...attempt(
        'b1',
        'acceptance',
        1,
        { kind: 'failed', retryable: true, reason: 'the out doc is missing' },
        { usage: usage(5, 5, 5, 5) },
      ),
      ...attempt('b1', 'acceptance', 2, tasted([]), { usage: usage(1, 1, 1, 1) }),
      ...ordered('b2', 2),
      ...attempt('b2', 'acceptance', 1, tasted([]), { usage: usage(100, 0, 0, 0) }),
      // No usage reported: it adds nothing.
      ...attempt('b2', 'acceptance', 2, tasted([])),
      // The Cellarman's tokens are no lens's.
      ...attempt('b2', 'implement', 1, implemented, { usage: usage(9, 9, 9, 9) }),
    ];
    assert.deepStrictEqual(
      lens(report(events), 'diff/acceptance'),
      tally({ rounds: 3, usage: usage(106, 6, 6, 6) }),
    );
  });

  it('lists every lens in use, by name, also one with no rounds', () => {
    const made = report([...ordered('b1', 1), ...attempt('b1', 'acceptance', 1, tasted([]))]);
    assert.deepStrictEqual(
      made.lenses.map(({ name, path }) => [name, path]),
      [
        ['diff/acceptance', 'defaults/lenses/diff/acceptance.md'],
        ['diff/correctness', 'defaults/lenses/diff/correctness.md'],
        ['diff/security', 'lenses/diff/security.md'],
      ],
    );
    assert.deepStrictEqual(lens(made, 'diff/security'), tally());
    assert.deepStrictEqual(made.gone, []);
  });

  it('counts a finding fixed in round 1 and gone in round 2 once, as fixed', () => {
    const events = [
      ...ordered('b1', 1),
      ...attempt('b1', 'correctness', 1, blocked, { findings: kept(finding('src/a.ts', 1)) }),
      ...attempt(
        'b1',
        'implement',
        2,
        disposed({ file: 'src/a.ts', line: 1, disposition: 'fixed' }),
        { from: 'correctness' },
      ),
      ...attempt('b1', 'correctness', 2, tasted([])),
    ];
    assert.deepStrictEqual(
      lens(report(events), 'diff/correctness'),
      tally({
        rounds: 2,
        severity: { blocker: 0, major: 1, minor: 0 },
        ends: { fixed: 1, dismissed: 0, 'pre-existing': 0, open: 0 },
      }),
    );
  });

  it('counts an open finding an advisory lens raises in two rounds once, with its latest severity', () => {
    const events = [
      ...ordered('b1', 1),
      ...attempt('b1', 'acceptance', 1, tasted([finding('src/a.ts', 1, 'minor')])),
      ...attempt('b1', 'correctness', 1, blocked, { findings: kept(finding('src/z.ts', 9)) }),
      ...attempt(
        'b1',
        'implement',
        2,
        disposed({ file: 'src/z.ts', line: 9, disposition: 'fixed' }),
        { from: 'correctness' },
      ),
      ...attempt('b1', 'acceptance', 2, tasted([finding('src/a.ts', 1, 'major')])),
    ];
    assert.deepStrictEqual(
      lens(report(events), 'diff/acceptance'),
      tally({
        rounds: 2,
        severity: { blocker: 0, major: 1, minor: 0 },
        ends: { fixed: 0, dismissed: 0, 'pre-existing': 0, open: 1 },
      }),
    );
  });

  it('counts a contest of a dismissal as a new finding (ADR 0191)', () => {
    const events = [
      ...ordered('b1', 1),
      ...attempt('b1', 'correctness', 1, blocked, { findings: kept(finding('src/a.ts', 1)) }),
      ...attempt(
        'b1',
        'implement',
        2,
        disposed({ file: 'src/a.ts', line: 1, disposition: 'dismissed', why: 'see a.test.ts:4' }),
        { from: 'correctness' },
      ),
      ...attempt('b1', 'correctness', 2, blocked, {
        findings: kept(finding('src/a.ts', 1, 'blocker')),
      }),
    ];
    assert.deepStrictEqual(
      lens(report(events), 'diff/correctness'),
      tally({
        rounds: 2,
        severity: { blocker: 1, major: 1, minor: 0 },
        ends: { fixed: 0, dismissed: 1, 'pre-existing': 0, open: 1 },
      }),
    );
  });

  it('counts a finding marked as there before the change, and also disposed so, once as pre-existing', () => {
    const before = finding('src/a.ts', 1, 'major', false);
    const events = [
      ...ordered('b1', 1),
      ...attempt('b1', 'correctness', 1, blocked, {
        findings: kept(before, finding('src/b.ts', 2)),
      }),
      ...attempt(
        'b1',
        'implement',
        2,
        disposed(
          { file: 'src/a.ts', line: 1, disposition: 'pre-existing', why: 'main has it at a.ts:1' },
          { file: 'src/b.ts', line: 2, disposition: 'fixed' },
        ),
        { from: 'correctness' },
      ),
      ...attempt('b1', 'correctness', 2, tasted([])),
      // An advisory lens's finding there before the change, which no one disposes of.
      ...attempt('b1', 'acceptance', 1, tasted([finding('src/c.ts', 3, 'minor', false)])),
    ];
    const made = report(events);
    assert.deepStrictEqual(
      lens(made, 'diff/correctness'),
      tally({
        rounds: 2,
        severity: { blocker: 0, major: 2, minor: 0 },
        ends: { fixed: 1, dismissed: 0, 'pre-existing': 1, open: 0 },
      }),
    );
    assert.deepStrictEqual(
      lens(made, 'diff/acceptance'),
      tally({
        rounds: 1,
        severity: { blocker: 0, major: 0, minor: 1 },
        ends: { fixed: 0, dismissed: 0, 'pre-existing': 1, open: 0 },
      }),
    );
  });

  it('counts a blocked round with no recorded findings, and the findings past the kept ones, as not recorded', () => {
    const events = [
      ...ordered('b1', 1),
      // Recorded before ADR 0221: its findings are unknown.
      ...attempt('b1', 'correctness', 1, blocked, { usage: usage(1, 0, 0, 0) }),
      ...attempt(
        'b1',
        'implement',
        2,
        disposed({ file: 'src/a.ts', line: 1, disposition: 'fixed' }),
        { from: 'correctness' },
      ),
      ...attempt('b1', 'correctness', 2, blocked, {
        findings: { kept: [finding('src/b.ts', 2)], more: 3 },
      }),
    ];
    assert.deepStrictEqual(
      lens(report(events), 'diff/correctness'),
      tally({
        rounds: 2,
        severity: { blocker: 0, major: 1, minor: 0 },
        ends: { fixed: 0, dismissed: 0, 'pre-existing': 0, open: 1 },
        notRecorded: { rounds: 1, findings: 3 },
        usage: usage(1, 0, 0, 0),
      }),
    );
  });

  it('lists apart a lens step the recipe files no longer have, by recipe and step', () => {
    const events = [
      ...ordered('b1', 1, 'old'),
      ...attempt('b1', 'review', 1, tasted([finding('src/a.ts', 1)]), {
        usage: usage(1, 1, 1, 1),
      }),
      // A step the files no longer have that never reviewed is no lens step.
      ...attempt('b1', 'plan', 1, { kind: 'succeeded', output: {} }, { usage: usage(7, 7, 7, 7) }),
      ...ordered('b2', 2),
      ...attempt('b2', 'taste', 1, tasted([])),
    ];
    const made = report(events);
    assert.deepStrictEqual(made.gone, [
      {
        recipe: 'nip',
        stepId: 'taste',
        ...tally({ rounds: 1 }),
      },
      {
        recipe: 'old',
        stepId: 'review',
        ...tally({
          rounds: 1,
          severity: { blocker: 0, major: 1, minor: 0 },
          ends: { fixed: 0, dismissed: 0, 'pre-existing': 0, open: 1 },
          usage: usage(1, 1, 1, 1),
        }),
      },
    ]);
    assert.deepStrictEqual(
      made.lenses.map((each) => each.rounds),
      [0, 0, 0],
    );
  });

  it('lists no step that blocked by findings without a Taster, as any brewer may (review of #572)', () => {
    const events = [
      ...ordered('b1', 1),
      // A brewer's own blocked out doc on findings records none: it is no lens's round.
      ...attempt('b1', 'implement', 1, blocked, { usage: usage(9, 9, 9, 9) }),
      ...ordered('b2', 2, 'old'),
      ...attempt('b2', 'gauge', 1, blocked, { usage: usage(1, 1, 1, 1) }),
    ];
    const made = report(events);
    assert.deepStrictEqual(made.gone, []);
    assert.deepStrictEqual(
      made.lenses.map(({ name: _, path: __, ...each }) => each),
      [tally(), tally(), tally()],
    );
  });

  it('pairs a disposition with a finding whose recorded file was cut to one spaced line (review of #572)', () => {
    const events = [
      ...ordered('b1', 1),
      // step.finished keeps the file as decide cuts it: its runs of whitespace as one space.
      ...attempt('b1', 'correctness', 1, blocked, {
        findings: kept(finding('docs/my notes.md', 1)),
      }),
      ...attempt(
        'b1',
        'implement',
        2,
        // The Cellarman read the Taster's own out doc, with the file as the Taster wrote it.
        disposed({ file: 'docs/my  notes.md', line: 1, disposition: 'fixed' }),
        { from: 'correctness' },
      ),
      ...attempt('b1', 'correctness', 2, tasted([])),
    ];
    assert.deepStrictEqual(
      lens(report(events), 'diff/correctness'),
      tally({
        rounds: 2,
        severity: { blocker: 0, major: 1, minor: 0 },
        ends: { fixed: 1, dismissed: 0, 'pre-existing': 0, open: 0 },
      }),
    );
  });
});

describe('formatLensReport', () => {
  it('prints each lens with its file, its findings, how they ended and its tokens', () => {
    const events = [
      ...ordered('b1', 1),
      ...attempt('b1', 'correctness', 1, blocked, {
        usage: usage(1_234_567, 20, 30, 40),
        findings: { kept: [finding('src/a.ts', 1, 'blocker'), finding('src/b.ts', 2)], more: 2 },
      }),
      ...attempt(
        'b1',
        'implement',
        2,
        disposed({ file: 'src/a.ts', line: 1, disposition: 'fixed' }),
        { from: 'correctness' },
      ),
      ...attempt('b1', 'correctness', 2, blocked),
      ...attempt('b1', 'acceptance', 1, tasted([])),
      ...ordered('b2', 2, 'old'),
      ...attempt('b2', 'review', 1, tasted([finding('src/c.ts', 3, 'minor')])),
    ];
    assert.equal(
      formatLensReport(report(events)),
      [
        'diff/acceptance  defaults/lenses/diff/acceptance.md',
        '  1 round, no findings',
        '  tokens: none reported',
        'diff/correctness  defaults/lenses/diff/correctness.md',
        '  2 rounds, 2 findings: 1 blocker, 1 major',
        '  ended: 1 fixed, 1 open',
        '  not recorded: 1 round, 2 findings',
        '  tokens: 1,234,567 input, 20 output, 30 cache read, 40 cache write',
        'diff/security  lenses/diff/security.md',
        '  no rounds',
        '',
        'Lens steps the recipe files no longer have (ADR 0059):',
        'old/review',
        '  1 round, 1 finding: 1 minor',
        '  ended: 1 open',
        '  tokens: none reported',
        '',
      ].join('\n'),
    );
  });

  it('says so when no recipe has a lens step', () => {
    assert.equal(formatLensReport(report([], { ...source, lenses: [] })), 'No lenses.\n');
  });
});

describe('lensSource', () => {
  // amber: implement (a committing brewer that reads a lens as an input, as the Gauger reads
  // diff/test-design) and taste (a Taster's lens step), from loaded files.
  const lensFile = (name: string) => ({
    path: `defaults/lenses/diff/${name}.md`,
    text: `Look at ${name}.`,
  });
  const loaded = loadRecipes({
    recipes: [
      {
        path: 'recipes/amber.jsonc',
        text: recipeText(
          'amber',
          [
            { id: 'implement', brewer: 'gauger' },
            { id: 'taste', brewer: 'taster', lens: 'diff/security' },
            { action: 'openPullRequest' },
          ],
          { testFirst: false },
        ),
      },
    ],
    brewers: [
      {
        path: 'brewers/gauger.md',
        text: brewerText('gauger', {
          access: 'write',
          git: { commit: true },
          produces: 'commits',
          inputs: [{ name: 'testDesign', from: 'lens:diff/test-design' }],
        }),
      },
      {
        path: 'brewers/taster.md',
        text: brewerText('taster', { output: { doc: 'taste.md', schema: 'tasting' } }),
      },
    ],
    defaults: { lenses: [lensFile('security'), lensFile('test-design'), lensFile('unused')] },
  });
  assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));

  it('lists the lenses a lens step reviews through, not one a brewer reads as an input', () => {
    assert.deepStrictEqual(lensSource(loaded).lenses, [
      { name: 'diff/security', path: 'defaults/lenses/diff/security.md' },
    ]);
  });

  it("gives a lens step's lens, none for another step, and nothing for a step no recipe has", () => {
    const { step } = lensSource(loaded);
    assert.deepStrictEqual(step('amber', 'taste'), { lens: 'diff/security' });
    assert.deepStrictEqual(step('amber', 'implement'), { lens: undefined });
    assert.equal(step('amber', 'review'), undefined);
    assert.equal(step('stout', 'taste'), undefined);
  });
});
