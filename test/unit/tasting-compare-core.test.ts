import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  addedLines,
  attemptsOf,
  choiceOf,
  escapeCell,
  type FinishedAttempt,
  type Key,
  keyProblems,
  nextRun,
  type RunRecord,
  readKey,
  recipeText,
  runFailure,
  SETUPS,
  scoreRun,
  scriptedTastings,
  summarize,
  tableMarkdown,
} from '../../scripts/tasting-compare/core.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';
import type { TastingFinding } from '../../src/schemas/out-doc.ts';
import { Recipe } from '../../src/schemas/recipe.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'tasting-compare');

/** A key of two defects: one in two ranges of a.ts, one in b.ts. */
const KEY: Key = {
  defects: [
    {
      id: 'logic',
      lens: 'diff/correctness',
      file: 'src/a.ts',
      lines: [
        [3, 4],
        [10, 10],
      ],
      what: 'a wrong condition',
    },
    { id: 'unasked', lens: 'diff/acceptance', file: 'src/b.ts', lines: [[5, 7]], what: 'unasked' },
  ],
};

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 300 };

const finding = (file: string | undefined, line: number | undefined, lens?: string) => ({
  ...(file === undefined ? {} : { file }),
  ...(line === undefined ? {} : { line }),
  severity: 'major' as const,
  why: `a finding at ${file}:${line}`,
  introduced: true,
  ...(lens === undefined ? {} : { lens }),
});

/** A run of `setup` whose Tasters ran the given attempts, on tap. */
const run = (
  setup: RunRecord['setup'],
  number: number,
  attempts: RunRecord['attempts'],
  extra: Partial<RunRecord> = {},
): RunRecord => ({ setup, run: number, ended: 'on_tap', wallMs: 60_000, attempts, ...extra });

const attempt = (
  stepId: string,
  lenses: readonly string[],
  findings: RunRecord['attempts'][number]['findings'],
  more: Partial<RunRecord['attempts'][number]> = {},
): RunRecord['attempts'][number] => ({
  stepId,
  lenses,
  failure: undefined,
  findings,
  usage: USAGE,
  turns: 5,
  durationMs: 30_000,
  ...more,
});

describe('the seeded change', () => {
  const key = readKey(readFileSync(join(fixture, 'key.json'), 'utf8'));
  const change = readFileSync(
    join(fixture, '0002-Remind-of-the-items-best-before-soon.patch'),
    'utf8',
  );

  it('plants exactly one defect per default diff lens', () => {
    assert.deepEqual(
      key.defects.map(({ lens }) => lens).sort(),
      SETUPS['together-7'].lenses.toSorted(),
    );
  });

  it("names, for every defect, ranges of lines the change adds to the defect's file", () => {
    assert.deepEqual(keyProblems(key, change), []);
  });

  it('keeps each line in one defect only', () => {
    const owner = new Map<string, string>();
    for (const { id, file, lines } of key.defects) {
      for (const [from, to] of lines) {
        for (let line = from; line <= to; line += 1) {
          const place = `${file}:${line}`;
          assert.equal(owner.get(place), undefined, `${place} is in ${owner.get(place)} and ${id}`);
          owner.set(place, id);
        }
      }
    }
  });
});

describe('addedLines', () => {
  it('numbers the lines a patch adds by the new file, past context and removed lines', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' one',
      '-two',
      '+TWO',
      '+three',
      ' four',
      '@@ -10 +11,2 @@',
      ' ten',
      '+eleven',
      'diff --git a/new.md b/new.md',
      '--- /dev/null',
      '+++ b/new.md',
      '@@ -0,0 +1 @@',
      '+hello',
      '-- ',
      '2.50.0',
    ].join('\n');
    assert.deepEqual(
      addedLines(patch),
      new Map([
        ['src/a.ts', new Set([2, 3, 12])],
        ['new.md', new Set([1])],
      ]),
    );
  });

  it('reads a patch with CRLF line ends', () => {
    const patch = ['+++ b/x.ts', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\r\n');
    assert.deepEqual(addedLines(patch), new Map([['x.ts', new Set([1, 2])]]));
  });
});

describe('keyProblems', () => {
  const patch = ['+++ b/src/a.ts', '@@ -0,0 +1,4 @@', '+1', '+2', '+3', '+4', ''].join('\n');

  it('names a range with no added line, and a file the change does not add to', () => {
    assert.deepEqual(keyProblems(KEY, patch), [
      'logic: src/a.ts:10-10 has no line the change adds',
      'unasked: the change adds no line to src/b.ts',
    ]);
  });
});

describe('readKey', () => {
  it('refuses a range that ends before it starts', () => {
    const text = JSON.stringify({
      defects: [{ id: 'x', lens: 'diff/correctness', file: 'a.ts', lines: [[4, 3]], what: 'x' }],
    });
    assert.throws(() => readKey(text), /range/);
  });
});

describe('the setups', () => {
  it('give each a recipe the schema accepts, its Tasters the default taster', () => {
    for (const name of ['apart-7', 'together-7', 'together-nip'] as const) {
      const recipe = Recipe.parse(parseJsonc(recipeText(name)));
      assert.equal(recipe.name, name);
      const tasters = JSON.stringify(recipe.steps.slice(1));
      assert.doesNotMatch(tasters, /"brewer":"(?!taster")/, name);
    }
  });

  it("give each a recipe a Brewery loads with Foedrum's defaults", () => {
    const brewery = makeTempDir('tasting-compare');
    try {
      for (const name of ['apart-7', 'together-7', 'together-nip'] as const) {
        mkdirSync(join(brewery.path, 'recipes'), { recursive: true });
        writeFileSync(join(brewery.path, 'recipes', `${name}.jsonc`), recipeText(name));
      }
      const loaded = loadRecipes(readBreweryFiles(brewery.path));
      assert.deepEqual(loaded.valid ? [] : loaded.problems, []);
    } finally {
      brewery.remove();
    }
  });

  it('taste apart-7 through a parallel group of the seven lenses, one step each', () => {
    const recipe = Recipe.parse(parseJsonc(recipeText('apart-7')));
    const group = recipe.steps[1];
    assert.ok(group !== undefined && 'parallel' in group);
    assert.deepEqual(
      group.parallel.map(({ lens }) => lens),
      SETUPS['apart-7'].lenses,
    );
  });

  it("taste together-nip through Nip's two lenses in one step", () => {
    const recipe = Recipe.parse(parseJsonc(recipeText('together-nip')));
    const step = recipe.steps[1];
    assert.ok(step !== undefined && 'brewer' in step);
    assert.deepEqual(step.lenses, ['diff/correctness', 'diff/acceptance']);
  });
});

describe('attemptsOf', () => {
  const finished = (stepId: string, outcome: FinishedAttempt['outcome']): FinishedAttempt => ({
    stepId,
    attempt: 1,
    outcome,
    usage: USAGE,
    receipt: { turns: 7, durationMs: 12_000 },
  });

  it("reads each Taster's findings, tokens, turns and time, and leaves the implementer out", () => {
    const attempts = attemptsOf(
      [
        finished('implement', { kind: 'succeeded', output: {} }),
        finished('security', {
          kind: 'succeeded',
          output: { verdict: 'changes', findings: [finding('src/a.ts', 3)] },
        }),
      ],
      'apart-7',
    );
    assert.deepEqual(attempts, [
      {
        stepId: 'security',
        lenses: ['diff/security'],
        failure: undefined,
        findings: [finding('src/a.ts', 3)],
        usage: USAGE,
        turns: 7,
        durationMs: 12_000,
      },
    ]);
  });

  it('keeps why an attempt failed, with no findings', () => {
    const [failed] = attemptsOf(
      [finished('taste', { kind: 'failed', retryable: true, reason: 'the out doc is invalid' })],
      'together-7',
    );
    assert.equal(failed?.failure, 'failed: the out doc is invalid');
    assert.deepEqual(failed?.findings, []);
  });

  it('drops a finding the schema refuses, and says so', () => {
    const [read] = attemptsOf(
      [
        finished('taste', {
          kind: 'succeeded',
          output: { findings: [{ file: 'a.ts', why: 'no severity' }, finding('a.ts', 1)] },
        }),
      ],
      'together-nip',
    );
    assert.deepEqual(read?.findings, [finding('a.ts', 1)]);
    assert.equal(read?.failure, 'succeeded with 1 finding the schema refuses');
  });
});

describe('runFailure', () => {
  it('is none for a run on tap whose Tasters all succeeded', () => {
    assert.equal(runFailure(run('together-7', 1, [attempt('taste', [], [])])), undefined);
  });

  it('names a batch that is not on tap', () => {
    const stuck = run('together-7', 1, [], { ended: 'stuck: attempts at step taste' });
    assert.equal(runFailure(stuck), 'the batch ended stuck: attempts at step taste');
  });

  it('names a failed Taster attempt, even when a retry of it succeeded', () => {
    const record = run('together-7', 1, [
      attempt('taste', [], [], { failure: 'failed: stalled' }),
      attempt('taste', [], []),
    ]);
    assert.equal(runFailure(record), 'taste: failed: stalled');
  });
});

describe('scoreRun', () => {
  const lenses = ['diff/correctness', 'diff/acceptance'];
  const score = (findings: ReturnType<typeof finding>[], stepLenses = lenses) =>
    scoreRun(run('together-nip', 1, [attempt('taste', stepLenses, findings)]), KEY);

  it('finds a defect by a finding in any of its ranges, whatever lens it names', () => {
    const { found } = score([finding('src/a.ts', 10, 'diff/acceptance')]);
    assert.deepEqual(found, [{ defect: 'logic', ownLens: false }]);
  });

  it('counts the defect for its own lens when one of its findings names it', () => {
    const { found } = score([
      finding('src/a.ts', 3, 'diff/acceptance'),
      finding('src/a.ts', 4, 'diff/correctness'),
    ]);
    assert.deepEqual(found, [{ defect: 'logic', ownLens: true }]);
  });

  it("reads a finding without a lens as its step's one lens", () => {
    const { found } = score([finding('src/a.ts', 3)], ['diff/correctness']);
    assert.deepEqual(found, [{ defect: 'logic', ownLens: true }]);
  });

  it('lists a finding out of range, in another file or with no file among the others', () => {
    const { found, others } = score([
      finding('src/a.ts', 5),
      finding('src/c.ts', 3),
      finding(undefined, undefined),
      finding('src/b.ts', undefined),
    ]);
    assert.deepEqual(found, []);
    assert.equal(others.length, 4);
  });

  it('matches a file given with ./ or backslashes, or as a path that ends in it', () => {
    const { found } = score([
      finding('.\\src\\a.ts', 3),
      finding('/work/batch/src/b.ts', 6, 'diff/acceptance'),
    ]);
    assert.deepEqual(found, [
      { defect: 'logic', ownLens: false },
      { defect: 'unasked', ownLens: true },
    ]);
  });

  it("scores only the defects of the setup's lenses, and lists the others' findings", () => {
    const only = {
      defects: [
        ...KEY.defects,
        { ...KEY.defects[0], id: 'sec', lens: 'diff/security', lines: [[20, 20]] },
      ],
    } as Key;
    const { found, others } = scoreRun(
      run('together-nip', 1, [attempt('taste', lenses, [finding('src/a.ts', 20)])]),
      only,
    );
    assert.deepEqual(found, []);
    assert.equal(others.length, 1);
  });
});

describe('summarize', () => {
  const apart = (number: number, extra: Partial<RunRecord> = {}): RunRecord =>
    run(
      'apart-7',
      number,
      [
        attempt('correctness', ['diff/correctness'], [finding('src/a.ts', 3)], {
          durationMs: 40_000,
        }),
        attempt('acceptance', ['diff/acceptance'], number === 1 ? [finding('src/b.ts', 5)] : [], {
          durationMs: 20_000,
        }),
        attempt('security', ['diff/security'], [finding('src/z.ts', 1)]),
      ],
      extra,
    );

  it('sums each run, and averages the runs of a setup', () => {
    const [summary] = summarize([apart(1), apart(2)], KEY).filter(
      ({ setup }) => setup === 'apart-7',
    );
    assert.deepEqual(summary?.found, [2, 1]);
    assert.equal(summary?.meanFound, 1.5);
    assert.deepEqual(summary?.perDefect.get('logic'), 2);
    assert.deepEqual(summary?.perDefect.get('unasked'), 1);
    assert.deepEqual(summary?.meanTokens, {
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 3000,
      cacheWriteTokens: 900,
      total: 4260,
    });
    assert.equal(summary?.meanTurns, 15);
    assert.equal(summary?.meanAttemptMs, 90_000);
    assert.equal(summary?.meanWallMs, 60_000);
    assert.deepEqual(
      summary?.others[0]?.map(({ finding: { file } }) => file),
      ['src/z.ts'],
    );
  });

  it("reads Nip's two apart from the apart runs' correctness and acceptance steps", () => {
    const nip = summarize([apart(1)], KEY).find(({ setup }) => setup === 'apart-nip');
    assert.equal(nip?.defects, 2);
    assert.deepEqual(nip?.found, [2]);
    assert.equal(nip?.meanTokens.total, 2840);
    assert.equal(nip?.meanTurns, 10);
    // Side by side: the longer of the two attempts.
    assert.equal(nip?.meanWallMs, 40_000);
    assert.deepEqual(nip?.others, [[]]);
  });

  it('scores the retry of a failed run, and counts the failed one', () => {
    const failed = apart(1, { ended: 'stuck: attempts' });
    const summary = summarize([failed, apart(1, { retry: true }), apart(2)], KEY).find(
      ({ setup }) => setup === 'apart-7',
    );
    assert.deepEqual(summary?.found, [2, 1]);
    assert.deepEqual(summary?.failed, [{ run: 1, why: 'the batch ended stuck: attempts' }]);
  });
});

describe('nextRun', () => {
  const ok = (setup: RunRecord['setup'], number: number, extra: Partial<RunRecord> = {}) =>
    run(setup, number, [attempt('taste', [], [])], extra);

  it('starts with the first run of the first setup', () => {
    assert.deepEqual(nextRun([], 3), { setup: 'apart-7', run: 1, retry: false });
  });

  it('runs a failed run again once, then goes on', () => {
    const failed = ok('apart-7', 1, { ended: 'stuck: x' });
    assert.deepEqual(nextRun([failed], 3), { setup: 'apart-7', run: 1, retry: true });
    assert.deepEqual(nextRun([failed, { ...failed, retry: true }], 3), {
      setup: 'apart-7',
      run: 2,
      retry: false,
    });
  });

  it('is done once every setup has its runs', () => {
    const records = (['apart-7', 'together-7', 'together-nip'] as const).flatMap((setup) =>
      [1, 2].map((number) => ok(setup, number)),
    );
    assert.equal(nextRun(records, 2), undefined);
  });
});

describe('choiceOf', () => {
  const summary = (setup: string, meanFound: number, total: number) =>
    ({ setup, meanFound, meanTokens: { total } }) as Parameters<typeof choiceOf>[0][number];

  it('tastes together with at least 30 % fewer tokens and at most half a defect fewer found', () => {
    const choice = choiceOf([
      summary('apart-7', 6, 1000),
      summary('together-7', 5.5, 700),
      summary('apart-nip', 2, 1000),
      summary('together-nip', 1.4, 500),
    ]);
    assert.deepEqual(choice, { seven: 'together', nip: 'apart' });
  });

  it('stays apart when together saves less than 30 %', () => {
    const choice = choiceOf([
      summary('apart-7', 6, 1000),
      summary('together-7', 7, 701),
      summary('apart-nip', 1, 1000),
      summary('together-nip', 2, 100),
    ]);
    assert.deepEqual(choice, { seven: 'apart', nip: 'together' });
  });
});

describe('scriptedTastings', () => {
  /** A run whose Tasters report what the dry run's script gives each step. */
  const played = (setup: RunRecord['setup']): RunRecord => {
    const script = scriptedTastings(setup, KEY);
    const lensesOf = (stepId: string) =>
      setup === 'apart-7' ? [`diff/${stepId}`] : SETUPS[setup].lenses;
    return run(
      setup,
      1,
      Object.entries(script).map(([stepId, [turn]]) =>
        attempt(stepId, lensesOf(stepId), (turn?.tasting?.findings ?? []) as TastingFinding[]),
      ),
    );
  };

  it('gives every Taster step of a setup one turn, and the implementer none', () => {
    assert.deepEqual(Object.keys(scriptedTastings('apart-7', KEY)).sort(), [
      'acceptance',
      'correctness',
      'cross-platform',
      'design-conformance',
      'necessity',
      'security',
      'test-design',
    ]);
    assert.deepEqual(Object.keys(scriptedTastings('together-7', KEY)), ['taste']);
  });

  it("reports each defect of the step's lenses, so the dry run finds them all by their own lens", () => {
    for (const setup of ['apart-7', 'together-nip'] as const) {
      assert.deepEqual(scoreRun(played(setup), KEY), {
        found: [
          { defect: 'logic', ownLens: true },
          { defect: 'unasked', ownLens: true },
        ],
        others: [],
      });
    }
  });
});

describe('escapeCell', () => {
  it('keeps model text from breaking out of its table cell', () => {
    assert.equal(
      escapeCell('a | b\r\n<script> `x` *y* [z](u) \\'),
      'a \\| b &lt;script&gt; \\`x\\` \\*y\\* \\[z\\](u) \\\\',
    );
  });
});

describe('tableMarkdown', () => {
  it("shows each setup's defects found, other findings, tokens and time, and the choice", () => {
    const text = tableMarkdown(
      summarize(
        [
          run('apart-7', 1, [
            attempt('correctness', ['diff/correctness'], [finding('src/a.ts', 3)]),
          ]),
          run('together-nip', 1, [
            attempt('taste', ['diff/correctness', 'diff/acceptance'], [finding('src/q.ts', 1)]),
          ]),
        ],
        KEY,
      ),
      KEY,
    );
    assert.match(text, /\| apart-7 \| 1 \/ 2 \| 1 \| 1 \| 0 \|/);
    assert.match(text, /\| together-nip \| 0 \/ 2 \| 0 \| 0 \| 1 \|/);
    assert.match(text, /\| logic \| diff\/correctness \| 1\/1 \|/);
    assert.match(text, /src\/q\.ts:1/);
    assert.match(text, /Nip:/);
  });

  it('says a setup with no runs has none, instead of an average of nothing', () => {
    const text = tableMarkdown(summarize([], KEY), KEY);
    assert.match(text, /\| together-7 \| no runs \|/);
  });
});
