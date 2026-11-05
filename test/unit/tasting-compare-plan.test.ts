import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  addedLines,
  type Key,
  type RunRecord,
  recipeText,
  summarize,
  tableMarkdown,
} from '../../scripts/tasting-compare/core.ts';
import {
  nextPlanRun,
  PLAN_SETUPS,
  type PlanRunRecord,
  type PlanSetupName,
  planRecipeText,
  planRecordOf,
  planRunFailure,
  planTableMarkdown,
  readPlanKey,
  readSeededPlan,
  scorePlanRun,
  scriptedPlanTastings,
  subOrderOfWhy,
  summarizePlan,
} from '../../scripts/tasting-compare/plan.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';
import type { Event } from '../../src/schemas/events.ts';
import { type PlannedSubOrder, PlanOutDoc } from '../../src/schemas/plan.ts';
import { Recipe } from '../../src/schemas/recipe.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 300 };

const root = join(import.meta.dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'tasting-compare');
const planFixture = join(fixture, 'plan');
const readText = (...path: string[]): string => readFileSync(join(...path), 'utf8');
const SETUP_NAMES = Object.keys(PLAN_SETUPS) as PlanSetupName[];

/** A default recipe's Taster steps that review a plan, as its group names them. */
const lensStepsOf = (name: string) => {
  const recipe = Recipe.parse(parseJsonc(readText(root, 'defaults', 'recipes', `${name}.jsonc`)));
  const group = recipe.steps.find((step) => 'parallel' in step);
  assert.ok(group !== undefined && 'parallel' in group);
  return group.parallel;
};

/** The seeded plan as its out doc's fields, parsed by the plan's own schema. */
const seededSubOrders = (): PlannedSubOrder[] => {
  const { doc, summary } = readSeededPlan(readText(planFixture, 'plan.json'));
  const parsed = PlanOutDoc.parse({ status: 'done', summary, ...doc });
  assert.ok(parsed.subOrders !== undefined);
  return parsed.subOrders;
};

const plantedKey = () => readPlanKey(readText(planFixture, 'key.json'));

describe('the seeded plan', () => {
  it('the seeded plan plants exactly one mistake per default plan lens', () => {
    const shipped = readdirSync(join(root, 'defaults', 'lenses', 'plan'))
      .map((name) => `plan/${name.slice(0, -'.md'.length)}`)
      .sort();
    assert.deepEqual(
      plantedKey()
        .mistakes.map(({ lens }) => lens)
        .sort(),
      shipped,
    );
  });

  it('the seeded plan is a done plan whose key names only its sub-orders and fields', () => {
    const subOrders = seededSubOrders();
    const planted = new Set<string>();
    for (const { id, subOrders: named, field } of plantedKey().mistakes) {
      assert.ok(named.length > 0, id);
      for (const name of named) {
        const entry: unknown = subOrders.find((subOrder) => subOrder.id === name);
        assert.ok(entry !== undefined, `${id} names no sub-order ${name}`);
        let value: unknown = entry;
        for (const part of field.split('.')) {
          value = (value as Record<string, unknown>)[part];
        }
        assert.ok(value !== undefined, `${id}: ${name} has no ${field}`);
        assert.equal(planted.has(name), false, `${name} holds two mistakes`);
        planted.add(name);
      }
    }
    // At least one sub-order holds nothing, as a control.
    assert.ok(subOrders.some(({ id }) => !planted.has(id)));
  });

  it("the seeded plan's touches exist at the base, or are marked new", () => {
    const base = addedLines(readText(fixture, '0001-Start-pantry.patch'));
    for (const { id, repo, touches } of seededSubOrders()) {
      assert.equal(repo, 'demo/web', id);
      for (const { path, new: isNew } of touches) {
        assert.equal(base.has(path), isNew !== true, `${id}: ${path}`);
      }
    }
  });

  it('the seeded plan leaves only its planted pair side by side on one file', () => {
    const subOrders = seededSubOrders();
    const waitsFor = (id: string): Set<string> => {
      const found = new Set<string>();
      const walk = (at: string): void => {
        for (const { on } of subOrders.find((each) => each.id === at)?.dependencies ?? []) {
          if (!found.has(on)) {
            found.add(on);
            walk(on);
          }
        }
      };
      walk(id);
      return found;
    };
    const sideBySide: string[] = [];
    for (const [at, a] of subOrders.entries()) {
      for (const b of subOrders.slice(at + 1)) {
        const shared = a.touches.some(({ path }) => b.touches.some((t) => t.path === path));
        if (shared && !waitsFor(a.id).has(b.id) && !waitsFor(b.id).has(a.id)) {
          sideBySide.push(`${a.id} ${b.id}`);
        }
      }
    }
    const pair = plantedKey().mistakes.find(({ lens }) => lens === 'plan/order-and-overlap');
    assert.deepEqual(sideBySide, [pair?.subOrders.join(' ')]);
  });
});

describe('the plan setups', () => {
  const stepsOf = (setup: PlanSetupName) => Recipe.parse(parseJsonc(planRecipeText(setup))).steps;

  it('plan mode measures the plan lenses Foedrum ships, no fewer and no more', () => {
    const shipped = readdirSync(join(root, 'defaults', 'lenses', 'plan'))
      .map((name) => `plan/${name.slice(0, -'.md'.length)}`)
      .sort();
    assert.deepEqual(PLAN_SETUPS['plan-apart-7'].lenses.toSorted(), shipped);
    assert.deepEqual(PLAN_SETUPS['plan-together-7'].lenses.toSorted(), shipped);
    assert.deepEqual(
      lensStepsOf('decoction')
        .map(({ lens }) => lens)
        .sort(),
      shipped,
    );
    assert.deepEqual(
      PLAN_SETUPS['plan-together-mash'].lenses.toSorted(),
      lensStepsOf('mash')
        .map(({ lens }) => lens)
        .sort(),
    );
  });

  it("plan mode's recipes load with Foedrum's defaults, with no blocking step", () => {
    const brewery = makeTempDir('tasting-compare-plan');
    try {
      mkdirSync(join(brewery.path, 'recipes'), { recursive: true });
      writeFileSync(
        join(brewery.path, 'recipes', 'prose.jsonc'),
        readText(planFixture, 'prose.jsonc'),
      );
      for (const name of SETUP_NAMES) {
        writeFileSync(join(brewery.path, 'recipes', `${name}.jsonc`), planRecipeText(name));
        assert.doesNotMatch(planRecipeText(name), /blocking|onBlocked|openPullRequest/, name);
      }
      const loaded = loadRecipes(readBreweryFiles(brewery.path));
      assert.deepEqual(loaded.valid ? [] : loaded.problems, []);
    } finally {
      brewery.remove();
    }
  });

  it('each apart step names the model decoction gives its lens, and a together step none', () => {
    const [plan, group] = stepsOf('plan-apart-7');
    assert.deepEqual(plan, { id: 'plan', brewer: 'brewmaster' });
    assert.ok(group !== undefined && 'parallel' in group);
    const models = (children: typeof group.parallel) =>
      children.map(({ lens, model }) => [lens, model]).sort();
    assert.deepEqual(models(group.parallel), models(lensStepsOf('decoction')));
    for (const setup of ['plan-together-7', 'plan-together-mash'] as const) {
      const step = stepsOf(setup)[1];
      assert.ok(step !== undefined && 'brewer' in step);
      assert.equal(step.model, undefined, setup);
    }
  });
});

describe('scoring a plan run', () => {
  const key = {
    mistakes: [
      { id: 'big', lens: 'plan/sizing', subOrders: ['stats'], field: 'size.lines', what: 'big' },
      {
        id: 'overlap',
        lens: 'plan/order-and-overlap',
        subOrders: ['keep-backup', 'atomic-save'],
        field: 'dependencies',
        what: 'side by side',
      },
    ],
  };
  const finding = (why: string, lens?: string) => ({
    severity: 'major' as const,
    why,
    introduced: true,
    ...(lens === undefined ? {} : { lens }),
  });
  const attempt = (
    stepId: string,
    lenses: readonly string[],
    findings: PlanRunRecord['attempts'][number]['findings'],
  ): PlanRunRecord['attempts'][number] => ({
    stepId,
    lenses,
    failure: undefined,
    findings,
    usage: USAGE,
    turns: 3,
    durationMs: 5_000,
  });
  const run = (
    setup: PlanSetupName,
    number: number,
    attempts: PlanRunRecord['attempts'],
  ): PlanRunRecord => ({
    setup,
    run: number,
    ended: 'stuck: plan_review',
    wallMs: 6_000,
    attempts,
  });

  it('a plan finding counts for the mistake whose sub-order starts its why, whatever lens it names', () => {
    const own = scorePlanRun(
      run('plan-apart-7', 1, [attempt('sizing', ['plan/sizing'], [finding('stats: too big')])]),
      key,
    );
    assert.deepEqual(own.found, [{ defect: 'big', ownLens: true }]);
    assert.deepEqual(own.others, []);
    const other = scorePlanRun(
      run('plan-apart-7', 1, [
        attempt('coverage', ['plan/coverage'], [finding('`stats`: unasked')]),
      ]),
      key,
    );
    assert.deepEqual(other.found, [{ defect: 'big', ownLens: false }]);
    const together = scorePlanRun(
      run('plan-together-7', 1, [
        attempt('taste', PLAN_SETUPS['plan-together-7'].lenses, [
          finding('stats: unasked', 'plan/coverage'),
          finding('stats: too big', 'plan/sizing'),
        ]),
      ]),
      key,
    );
    assert.deepEqual(together.found, [{ defect: 'big', ownLens: true }]);
  });

  it('a finding on a clean sub-order or on none is listed among the others', () => {
    const clean = finding('remind: reads well');
    const none = finding('the order asks for no such thing');
    const { found, others } = scorePlanRun(
      run('plan-apart-7', 1, [attempt('coverage', ['plan/coverage'], [clean, none])]),
      key,
    );
    assert.deepEqual(found, []);
    assert.deepEqual(
      others.map(({ stepId, finding: { why } }) => [stepId, why]),
      [
        ['coverage', clean.why],
        ['coverage', none.why],
      ],
    );
  });

  it('a mistake of two sub-orders counts on either', () => {
    for (const id of ['keep-backup', 'atomic-save']) {
      const { found } = scorePlanRun(
        run('plan-apart-7', 1, [
          attempt('order-and-overlap', ['plan/order-and-overlap'], [finding(`${id}: both`)]),
        ]),
        key,
      );
      assert.deepEqual(found, [{ defect: 'overlap', ownLens: true }], id);
    }
  });

  it('a finding on a mistake of a lens outside the setup is listed among the others', () => {
    const { found, others } = scorePlanRun(
      run('plan-together-mash', 1, [
        attempt('taste', PLAN_SETUPS['plan-together-mash'].lenses, [
          finding('atomic-save: both', 'plan/coverage'),
        ]),
      ]),
      key,
    );
    assert.deepEqual(found, []);
    assert.equal(others.length, 1);
  });

  it('reads the sub-order at the very start of a why, with or without backticks around it', () => {
    assert.equal(subOrderOfWhy('stats: too big'), 'stats');
    assert.equal(subOrderOfWhy('`keep-backup`: both'), 'keep-backup');
    assert.equal(subOrderOfWhy('step-2: both'), 'step-2');
    for (const why of [
      '`stats: an opening backtick only',
      'stats`: a closing backtick only',
      ' stats: a blank before it',
      'see stats: not at the start',
      'Stats: not as an id is written',
      'stats too big',
      '',
      `${'a'.repeat(100_000)} no colon`,
    ]) {
      assert.equal(subOrderOfWhy(why), undefined, why.slice(0, 40));
    }
  });

  it('a plan run that ended at its plan review did not fail, and one that ended otherwise did', () => {
    const waiting = run('plan-apart-7', 1, []);
    assert.equal(planRunFailure(waiting), undefined);
    for (const ended of ['on_tap', 'stuck: attempts_exhausted', 'cancelled', 'not ended']) {
      assert.equal(planRunFailure({ ...waiting, ended }), `the batch ended ${ended}`);
    }
  });

  it('a plan run with a failed Taster attempt failed, though it ended at its plan review', () => {
    const failed = { ...attempt('sizing', ['plan/sizing'], []), failure: 'failed: invalid' };
    assert.equal(planRunFailure(run('plan-apart-7', 1, [failed])), 'sizing: failed: invalid');
  });

  it('brews a run with no record, a failed one once more, and then the next setup', () => {
    assert.deepEqual(nextPlanRun([], 2), { setup: 'plan-apart-7', run: 1, retry: false });
    const done = run('plan-apart-7', 1, []);
    assert.deepEqual(nextPlanRun([{ ...done, ended: 'on_tap' }], 1), {
      setup: 'plan-apart-7',
      run: 1,
      retry: true,
    });
    assert.deepEqual(nextPlanRun([done], 1), { setup: 'plan-together-7', run: 1, retry: false });
    const all = SETUP_NAMES.map((setup) => run(setup, 1, []));
    assert.equal(nextPlanRun(all, 1), undefined);
  });

  describe('a scripted plan run', () => {
    /** A run's events: the plan step, each scripted Taster as it finished, and the review. */
    const eventsOf = (setup: PlanSetupName) => {
      const finished = (stepId: string, output: unknown) => ({
        event: {
          type: 'step.finished',
          stepId,
          attempt: 1,
          outcome: { kind: 'succeeded', output },
          usage: USAGE,
          receipt: { turns: 3, durationMs: 5_000 },
        } as unknown as Event,
      });
      const tasters = Object.entries(scriptedPlanTastings(setup, plantedKey())).map(
        ([stepId, turns]) => finished(stepId, turns[0]?.tasting),
      );
      const stuck = { type: 'batch.stuck', reason: { kind: 'plan_review' } } as unknown as Event;
      return [finished('plan', {}), ...tasters, { event: stuck }];
    };
    const scripted = (setup: PlanSetupName, number = 1): PlanRunRecord => ({
      setup,
      run: number,
      wallMs: 6_000,
      ...planRecordOf(eventsOf(setup), setup),
    });

    it('a scripted plan run where every lens finds its mistake scores seven of seven', () => {
      for (const setup of ['plan-apart-7', 'plan-together-7'] as const) {
        const record = scripted(setup);
        assert.equal(planRunFailure(record), undefined, setup);
        const { found, others } = scorePlanRun(record, plantedKey());
        assert.equal(found.length, 7, setup);
        assert.ok(
          found.every(({ ownLens }) => ownLens),
          setup,
        );
        assert.deepEqual(others, [], setup);
      }
    });

    it("scores mash's three lenses three of three, together and read from the seven apart", () => {
      const summaries = summarizePlan(
        SETUP_NAMES.map((setup) => scripted(setup)),
        plantedKey(),
      );
      assert.deepEqual(
        summaries.map(({ setup, found, defects }) => [setup, found, defects]),
        [
          ['plan-apart-7', [7], 7],
          ['plan-together-7', [7], 7],
          ['plan-apart-mash', [3], 3],
          ['plan-together-mash', [3], 3],
        ],
      );
      // Its three steps ran inside the seven's run: three attempts' tokens, and no wall time.
      const apartMash = summaries[2];
      assert.equal(apartMash?.meanTokens.total, 3 * 1420);
      assert.ok(Number.isNaN(apartMash?.meanWallMs));
    });

    it("prints the one table: the four setups, each mistake, and ADR 0224's choice", () => {
      const table = planTableMarkdown(
        summarizePlan(
          SETUP_NAMES.map((setup) => scripted(setup)),
          plantedKey(),
        ),
        plantedKey(),
      );
      assert.match(table, /^\| plan-apart-7 \| 7 \/ 7 \| 7 \| 7 \|/m);
      assert.match(table, /^\| plan-apart-mash \| 3 \/ 3 \| 3 \| 3 \|/m);
      assert.match(
        table,
        /^\| Mistake \| Lens \| plan-apart-7 \| plan-together-7 \| plan-apart-mash \| plan-together-mash \|$/m,
      );
      assert.match(table, /^\| it-works \| plan\/testability \| 1\/1 \| 1\/1 \| - \| - \|$/m);
      assert.match(
        table,
        /^\| already-done \| plan\/coverage \| 1\/1 \| 1\/1 \| 1\/1 \| 1\/1 \|$/m,
      );
      assert.match(table, /^- Mash: apart \(plan-apart-mash against plan-together-mash\)$/m);
      assert.match(table, /^- Seven lenses: apart \(plan-apart-7 against plan-together-7\)$/m);
    });
  });
});

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
