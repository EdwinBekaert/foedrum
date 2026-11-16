import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TasterAttempt } from '../../scripts/tasting-compare/core.ts';
import {
  blinded,
  codeOf,
  type RealRecord,
  type TastedRecord,
  type TasterSettings,
} from '../../scripts/tasting-compare/real.ts';
import { scoredTable } from '../../scripts/tasting-compare/score.ts';

const SEED = 'a seed';

/** A key as #879 writes its own, out of order by order, so the table's grouping shows. */
const KEY = [
  '## The key and the bar, fixed before any run',
  '',
  '| Id | Order | What a Taster must name | Place at the brewed head |',
  '|---|---|---|---|',
  '| M1 | #867 | A synthetic defect one | `src/a.ts:1` |',
  '| M2 | #867 | A synthetic defect two | `src/a.ts:2` |',
  '| D1 | #855 | A synthetic stale page | `docs/a.md:3` |',
  '',
  '- **Caught in a run:** a finding names the defect.',
].join('\n');

const ON_LEVEL: TasterSettings = {
  brewer: 'taster',
  model: 'strong',
  effort: 'larger',
  lenses: 'apart',
  rules: 'reads',
};
const ON_ID: TasterSettings = {
  brewer: 'taster',
  model: 'claude-opus-5-5',
  effort: 'full',
  lenses: 'together',
  rules: 'bare',
};

const attempt = (stepId: string, model: string, tokens: number): TasterAttempt => ({
  stepId,
  lenses: [`diff/${stepId}`],
  failure: undefined,
  findings: [],
  usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  turns: 1,
  durationMs: 1,
  models: [model],
});

const setupOf = (settings: TasterSettings, order: number): TastedRecord['setup'] =>
  `${order}-taster-${settings.model}-${settings.effort}-${settings.lenses}-${settings.rules}` as TastedRecord['setup'];

/** A run of `settings` on `order`, each Taster on `model` with `tokens` tokens. */
const record = (
  settings: TasterSettings,
  order: number,
  run: number,
  model = 'claude-opus-5-5',
  tokens = 100_000,
): TastedRecord => ({
  setup: setupOf(settings, order),
  run,
  ended: 'on_tap',
  wallMs: 1,
  attempts:
    settings.lenses === 'together'
      ? [attempt('together', model, tokens)]
      : ['correctness', 'acceptance', 'security'].map((id) => attempt(id, model, tokens)),
  taster: settings,
});

interface Mark {
  order: number;
  code: string;
  caught: string[];
  outside: { finding: string; verdict: 'true' | 'false' }[];
}

const mark = (
  settings: TasterSettings,
  order: number,
  run: number,
  caught: string[] = [],
  outside: Mark['outside'] = [],
): Mark => ({ order, code: codeOf(SEED, setupOf(settings, order), run), caught, outside });

const tableOf = (records: readonly TastedRecord[], marks: readonly Mark[]): string =>
  scoredTable({
    key: KEY,
    codes: blinded(records, SEED).codes,
    marks: JSON.stringify({ runs: marks }),
  });

/** The cells of the table's row whose Setup cell is `label`, or of its header with `Setup`. */
const rowOf = (table: string, label: string): string[] => {
  const line = table
    .split('\n')
    .find((each) => each.startsWith(`| ${label} |`) || each.startsWith(`| \`${label}\` |`));
  assert.ok(line !== undefined, `no row ${label} in:\n${table}`);
  return line
    .slice(2, -2)
    .split(' | ')
    .map((cell) => cell.replaceAll('`', ''));
};

/** Three runs of ON_LEVEL on 855 and two on 867, two of ON_ID on 855, interleaved. */
const RECORDS = [
  record(ON_LEVEL, 867, 2),
  record(ON_ID, 855, 1),
  record(ON_LEVEL, 855, 1),
  record(ON_LEVEL, 855, 3),
  record(ON_ID, 855, 2),
  record(ON_LEVEL, 855, 2),
  record(ON_LEVEL, 867, 1),
];
const MARKS: Mark[] = [
  mark(ON_LEVEL, 855, 1, ['D1']),
  mark(ON_LEVEL, 855, 2, ['D1']),
  mark(ON_LEVEL, 855, 3),
  mark(ON_LEVEL, 867, 1, ['M1']),
  mark(ON_LEVEL, 867, 2, ['M2', 'M1']),
  mark(ON_ID, 855, 1, ['D1']),
  mark(ON_ID, 855, 2),
];

describe('tasting-score: the unblinding of a scored comparison (ADR 0403)', () => {
  it('marks and codes.md give each setup its catches per key item, the key items grouped by order', () => {
    const table = tableOf(RECORDS, MARKS);
    assert.deepEqual(rowOf(table, 'Setup').slice(0, 4), ['Setup', 'D1', 'M1', 'M2']);
    assert.deepEqual(rowOf(table, 'taster-strong-larger-apart-reads').slice(1, 4), [
      '2/3',
      '2/2',
      '1/2',
    ]);
    assert.deepEqual(rowOf(table, 'taster-claude-opus-5-5-full-together-bare').slice(1, 4), [
      '1/2',
      '-',
      '-',
    ]);
  });

  it('findings outside the key are counted true and false per setup', () => {
    const marks = MARKS.map((each) =>
      each.code === mark(ON_LEVEL, 855, 3).code
        ? {
            ...each,
            outside: [
              { finding: 'a true one', verdict: 'true' as const },
              { finding: 'a false one', verdict: 'false' as const },
            ],
          }
        : each.code === mark(ON_LEVEL, 867, 1).code
          ? { ...each, outside: [{ finding: 'another true one', verdict: 'true' as const }] }
          : each,
    );
    const table = tableOf(RECORDS, marks);
    assert.equal(rowOf(table, 'Setup')[4], 'Findings outside the key');
    assert.equal(rowOf(table, 'taster-strong-larger-apart-reads')[4], '2 true, 1 false');
    assert.equal(rowOf(table, 'taster-claude-opus-5-5-full-together-bare')[4], 'none');
  });

  it("tokens per batch are each run's Tasters' tokens in codes.md, as a mean and a range", () => {
    const records = [
      record(ON_ID, 855, 1, 'claude-opus-5-5', 253_000),
      record(ON_ID, 855, 2, 'claude-opus-5-5', 1_046_000),
      record(ON_ID, 855, 3, 'claude-opus-5-5', 261_000),
    ];
    const marks = [mark(ON_ID, 855, 1), mark(ON_ID, 855, 2), mark(ON_ID, 855, 3)];
    const table = tableOf(records, marks);
    assert.equal(rowOf(table, 'Setup')[4 + 1], 'Tokens per batch, mean (range)');
    assert.equal(
      rowOf(table, 'taster-claude-opus-5-5-full-together-bare')[5],
      '520k (253k–1,046k)',
    );
  });

  it('the table shows the model each Taster ran on, with how many Tasters', () => {
    const records = [
      record(ON_LEVEL, 855, 1, 'claude-opus-5-5'),
      record(ON_LEVEL, 855, 2, 'claude-opus-6-0'),
    ];
    const table = tableOf(records, [mark(ON_LEVEL, 855, 1), mark(ON_LEVEL, 855, 2)]);
    assert.equal(rowOf(table, 'Setup')[6], 'Ran on');
    assert.equal(
      rowOf(table, 'taster-strong-larger-apart-reads')[6],
      'claude-opus-5-5 (3); claude-opus-6-0 (3)',
    );
  });

  it('a model its settings did not ask for shows as not asked', () => {
    const records = [
      record(ON_LEVEL, 855, 1, 'claude-opus-5-5'),
      record(ON_LEVEL, 855, 2, 'claude-sonnet-5-5'),
      record(ON_ID, 855, 1, 'claude-opus-5-5-20261101'),
      record(ON_ID, 855, 2, 'claude-opus-5-5-preview'),
    ];
    const marks = [
      mark(ON_LEVEL, 855, 1),
      mark(ON_LEVEL, 855, 2),
      mark(ON_ID, 855, 1),
      mark(ON_ID, 855, 2),
    ];
    const table = tableOf(records, marks);
    assert.equal(
      rowOf(table, 'taster-strong-larger-apart-reads')[6],
      'claude-opus-5-5 (3); claude-sonnet-5-5 (3), not asked: opus',
    );
    assert.equal(
      rowOf(table, 'taster-claude-opus-5-5-full-together-bare')[6],
      'claude-opus-5-5-20261101 (1); claude-opus-5-5-preview (1), not asked: claude-opus-5-5',
    );
  });

  it("a fixed setup's row shows its models with no asked check", () => {
    const fixed: RealRecord = {
      setup: '855-reads',
      run: 1,
      ended: 'on_tap',
      wallMs: 1,
      attempts: [attempt('correctness', 'claude-haiku-5-5', 1000)],
    };
    const marks = [{ order: 855, code: codeOf(SEED, '855-reads', 1), caught: [], outside: [] }];
    assert.equal(rowOf(tableOf([fixed], marks), 'reads')[6], 'claude-haiku-5-5 (1)');
  });

  it('the key names the columns, so an order and its items need no change to the script', () => {
    const key = [
      '| Id | Order | What a Taster must name | Place at the brewed head |',
      '|---|---|---|---|',
      '| X7 | #864 | A synthetic defect | `src/b.ts:1` |',
    ].join('\n');
    const records = [record(ON_ID, 864, 1)];
    const table = scoredTable({
      key,
      codes: blinded(records, SEED).codes,
      marks: JSON.stringify({ runs: [mark(ON_ID, 864, 1, ['X7'])] }),
    });
    assert.deepEqual(rowOf(table, 'Setup').slice(0, 2), ['Setup', 'X7']);
    assert.equal(rowOf(table, 'taster-claude-opus-5-5-full-together-bare')[1], '1/1');
  });

  it('a mark of an order the key does not name is refused', () => {
    const records = [...RECORDS, record(ON_ID, 864, 1)];
    assert.throws(() => tableOf(records, [...MARKS, mark(ON_ID, 864, 1)]), /#864.*not in the key/);
  });

  it('a mark whose code codes.md does not hold is refused', () => {
    assert.throws(
      () => tableOf(RECORDS, [...MARKS, { order: 855, code: 'deadbeef', caught: [], outside: [] }]),
      /deadbeef.*not in codes\.md/,
    );
  });

  it('a mark whose code codes.md holds for another order is refused', () => {
    const moved = { ...mark(ON_ID, 855, 2), order: 867 };
    const marks = MARKS.map((each) => (each.code === moved.code ? moved : each));
    assert.throws(() => tableOf(RECORDS, marks), new RegExp(`${moved.code}.*not in codes\\.md`));
  });

  it('a run of an order the key names with no mark is refused', () => {
    const left = mark(ON_LEVEL, 867, 2).code;
    assert.throws(
      () =>
        tableOf(
          RECORDS,
          MARKS.filter(({ code }) => code !== left),
        ),
      new RegExp(`${left}.*no mark`),
    );
  });

  it("a caught item that is not of its run's order is refused", () => {
    const marks = MARKS.map((each) =>
      each.code === mark(ON_ID, 855, 2).code ? { ...each, caught: ['M1'] } : each,
    );
    assert.throws(() => tableOf(RECORDS, marks), /M1.*not a key item of #855/);
  });
});
