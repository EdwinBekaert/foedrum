import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Key,
  type RunRecord,
  recipeText,
  summarize,
  tableMarkdown,
} from '../../scripts/tasting-compare/core.ts';

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 300 };

describe('the diff mode beside plan mode', () => {
  const key: Key = {
    defects: [
      { id: 'logic', lens: 'diff/correctness', file: 'a.ts', lines: [[3, 4]], what: 'wrong' },
      { id: 'unasked', lens: 'diff/acceptance', file: 'b.ts', lines: [[5, 5]], what: 'unasked' },
    ],
  };
  const taster = (stepId: string, lenses: readonly string[], findings: unknown[]) =>
    ({
      stepId,
      lenses,
      failure: undefined,
      findings,
      usage: USAGE,
      turns: 2,
      durationMs: 4_000,
    }) as RunRecord['attempts'][number];
  const major = { severity: 'major', introduced: true } as const;
  const records: RunRecord[] = [
    {
      setup: 'apart-7',
      run: 1,
      ended: 'on_tap',
      wallMs: 9_000,
      attempts: [
        taster(
          'correctness',
          ['diff/correctness'],
          [{ ...major, file: 'a.ts', line: 3, why: 'w' }],
        ),
        taster('acceptance', ['diff/acceptance'], [{ ...major, why: 'elsewhere' }]),
      ],
    },
    {
      setup: 'together-7',
      run: 1,
      ended: 'stuck: blocked',
      wallMs: 1_000,
      attempts: [],
    },
  ];

  it('prints the table it printed before plan mode (regression test)', () => {
    assert.equal(
      tableMarkdown(summarize(records, key), key),
      [
        '| Setup | Found (mean) | Per run | Own lens (mean) | Other findings (mean) | Input | Output | Cache read | Cache write | Tokens | Turns | Attempts | Tasting | Wall | Failed runs |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
        '| apart-7 | 1 / 2 | 1 | 1 | 1 | 200 | 40 | 2,000 | 600 | 2,840 | 4 | 8 s | 4 s | 9 s | 0 |',
        '| together-7 | no runs |  |  |  |  |  |  |  |  |  |  |  |  | 1 |',
        '| apart-nip | 1 / 2 | 1 | 1 | 1 | 200 | 40 | 2,000 | 600 | 2,840 | 4 | 8 s | 4 s | - | 0 |',
        '| together-nip | no runs |  |  |  |  |  |  |  |  |  |  |  |  | 0 |',
        '',
        '| Defect | Lens | apart-7 | together-7 | apart-nip | together-nip |',
        '|---|---|---|---|---|---|',
        '| logic | diff/correctness | 1/1 | - | 1/1 | - |',
        '| unasked | diff/acceptance | 0/1 | - | 0/1 | - |',
        '',
        '- Nip: not measured (apart-nip against together-nip)',
        '- Seven lenses: not measured (apart-7 against together-7)',
        '',
        'Other findings of apart-7, scored run 1:',
        '',
        '- acceptance: major in no file: elsewhere',
        '',
        'Failed: together-7 run 1: the batch ended stuck: blocked',
        '',
      ].join('\n'),
    );
  });

  it('writes the recipes it wrote before plan mode (regression test)', () => {
    assert.equal(
      recipeText('together-nip'),
      `// node scripts/tasting-compare.ts's setup together-nip (ADR 0224).\n${JSON.stringify(
        {
          name: 'together-nip',
          description: 'The seeded change of #567, tasted together',
          testFirst: false,
          steps: [
            { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
            { id: 'implement', brewer: 'cellarman' },
            {
              id: 'taste',
              brewer: 'taster',
              lenses: ['diff/correctness', 'diff/acceptance', 'diff/security'],
            },
            { action: 'openPullRequest' },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });
});
