import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { BREWERY, localConfig, TARGET, USER } from '../../scripts/demo/core.ts';
import type { TasterAttempt } from '../../scripts/tasting-compare/core.ts';
import {
  bareTaster,
  blinded,
  brewerSettingsOf,
  modelStop,
  REAL_SETUPS,
  type RealRecord,
  realBreweryFiles,
  realRecipeOf,
  realRecordOf,
  realTable,
  scriptedRealTastings,
  scriptedTranscript,
  TASTER_RECIPE,
  type TastedRecord,
  type TasterSettings,
  tasterBreweryFiles,
  tasterSetups,
  withoutLevels,
} from '../../scripts/tasting-compare/real.ts';
import { effortOf, modelOf } from '../../src/brewers/attempt-plan.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';
import type { Event } from '../../src/schemas/events.ts';
import { nipBreweryFiles } from '../helpers/nip-fixture.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const root = resolve(import.meta.dirname, '..', '..');
/** The Taster that reads the rules, which the reads and bare Tasters start from (ADR 0352). */
const READS = readFileSync(
  join(root, 'test', 'fixtures', 'tasting-compare', 'real', 'taster-reads.md'),
  'utf8',
);
const TASTERS = { today: 'the old text', reads: READS };
const NAMES = { brewery: BREWERY, target: TARGET, user: USER };
const SESSION = '00000000-0000-4000-8000-000000000001';

const ON_ID: TasterSettings = {
  brewer: 'taster',
  model: 'claude-opus-5-5',
  effort: 'full',
  lenses: 'together',
  rules: 'bare',
};
const ON_LEVEL: TasterSettings = {
  brewer: 'taster',
  model: 'strong',
  effort: 'larger',
  lenses: 'apart',
  rules: 'reads',
};

const given = (more: Record<string, unknown>) => ({
  real: true,
  brewer: 'taster',
  model: 'strong',
  effort: 'larger',
  lenses: 'apart',
  rules: 'reads',
  ...more,
});

/** A Taster step's `claude` line in a run of `settings`, through serve's own setup of its Brewery. */
const commandLine = (settings: TasterSettings, stepId: string): string[] => {
  const brewery = makeTempDir('tasting-compare-real-taster');
  try {
    const { 'models.jsonc': _, ...nip } = nipBreweryFiles(NAMES);
    const files: Record<string, string> = {
      ...nip,
      ...tasterBreweryFiles(settings, TASTERS),
      '.foedrum/local.jsonc': localConfig(join(brewery.path, 'work'), join(brewery.path, 'web')),
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(brewery.path, path)), { recursive: true });
      writeFileSync(join(brewery.path, path), text);
    }
    const ready = serveSetup({
      root: brewery.path,
      home: join(brewery.path, 'home'),
      platform: process.platform,
      env: {},
      files: {
        config: files['foedrum.jsonc'],
        local: files['.foedrum/local.jsonc'],
        models: files['models.jsonc'],
        brewery: readBreweryFiles(brewery.path),
      },
      diagnosis: {
        tools: [{ name: 'claude', version: undefined, path: 'claude' }],
        isolation: { level: 'permissions only', why: 'a test' },
        problems: [],
      },
    });
    assert.ok(ready.kind !== 'refused', JSON.stringify(ready));
    const step = ready.setup.brewers.find(TASTER_RECIPE, stepId);
    assert.ok(step !== undefined, stepId);
    return claudeArgs({
      model: modelOf(ready.setup.models, step.brewer),
      effort: effortOf(ready.setup.models, step.brewer),
      settingsFile: 'settings.json',
      tools: ['Read'],
      session: { kind: 'new', id: SESSION },
    });
  } finally {
    brewery.remove();
  }
};

const optionValue = (line: readonly string[], option: string): string | undefined =>
  line[line.indexOf(option) + 1];

/** The taste step of a run's recipe, as its Brewery file holds it. */
const tasteStepOf = (settings: TasterSettings): Record<string, unknown> => {
  const text = tasterBreweryFiles(settings, TASTERS)[`recipes/${TASTER_RECIPE}.jsonc`] ?? '';
  const recipe = parseJsonc(text) as { steps: Record<string, unknown>[] };
  const taste = recipe.steps.find(
    (step) => step.brewer === 'taster' || Array.isArray(step.parallel),
  );
  assert.ok(taste !== undefined, text);
  return taste;
};

const attempt = (stepId: string, lenses: string[], models: string[]): TasterAttempt => ({
  stepId,
  lenses,
  failure: undefined,
  findings: [
    {
      file: 'src/a.ts',
      line: 3,
      severity: 'major',
      why: `a finding through ${lenses[0]}`,
      introduced: true,
      ...(lenses.length === 1 ? {} : { lens: lenses[0] }),
    },
  ],
  usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  turns: 5,
  durationMs: 6,
  models,
});

/** A run of a Taster setup built from `settings` on `order`, its Tasters on `model`. */
const settingsRecord = (
  settings: TasterSettings,
  order: number,
  run: number,
  model: string,
): TastedRecord => ({
  setup:
    `${order}-taster-${settings.model}-${settings.effort}-${settings.lenses}-${settings.rules}` as TastedRecord['setup'],
  run,
  ended: 'on_tap',
  wallMs: 1,
  attempts:
    settings.lenses === 'together'
      ? [attempt('together', ['diff/correctness', 'diff/acceptance', 'diff/security'], [model])]
      : ['correctness', 'acceptance', 'security'].map((id) => attempt(id, [`diff/${id}`], [model])),
  taster: settings,
});

const fixedRecord = (setup: RealRecord['setup'], run: number): RealRecord => ({
  setup,
  run,
  ended: 'on_tap',
  wallMs: 1,
  attempts: [attempt('correctness', ['diff/correctness'], ['claude-sonnet-5-5'])],
});

/** A run of a settings setup on 855, its Taster on a dated snapshot of the id asked, and a fixed run beside it. */
const settings = settingsRecord(ON_ID, 855, 1, 'claude-opus-5-5-20261101');
const fixed = fixedRecord('855-reads', 1);

describe('tasting-compare --real --brewer taster (ADR 0402)', () => {
  describe('the options', () => {
    it("--brewer taster with a model, an effort, lenses and rules gives a Taster setup's settings", () => {
      assert.deepEqual(brewerSettingsOf(given({})), ON_LEVEL);
      assert.deepEqual(
        brewerSettingsOf(
          given({ model: 'claude-opus-5-5', effort: 'full', lenses: 'together', rules: 'bare' }),
        ),
        ON_ID,
      );
    });

    it('--brewer taster without --lenses or --rules is refused: neither has a default', () => {
      assert.throws(() => brewerSettingsOf(given({ lenses: undefined })), /--lenses/);
      assert.throws(() => brewerSettingsOf(given({ rules: undefined })), /--rules/);
    });

    it('--lenses and --rules take their two words each, and nothing else', () => {
      assert.throws(
        () => brewerSettingsOf(given({ lenses: 'mixed' })),
        /--lenses.*apart.*together.*"mixed"/,
      );
      assert.throws(
        () => brewerSettingsOf(given({ rules: 'some' })),
        /--rules.*reads.*bare.*"some"/,
      );
    });

    it('--lenses or --rules without --brewer taster is refused, beside --brewer cellarman too', () => {
      assert.throws(() => brewerSettingsOf({ real: true, lenses: 'apart' }), /--brewer taster/);
      assert.throws(() => brewerSettingsOf({ real: true, rules: 'bare' }), /--brewer taster/);
      for (const more of [{ lenses: 'apart' }, { rules: 'bare' }]) {
        assert.throws(
          () =>
            brewerSettingsOf({
              real: true,
              brewer: 'cellarman',
              model: 'claude-opus-5-5',
              effort: 'full',
              ...more,
            }),
          /--brewer taster/,
          JSON.stringify(more),
        );
      }
    });

    it('--map, --order-text and --setups beside --brewer taster are refused', () => {
      assert.throws(() => brewerSettingsOf(given({ map: true })), /--map/);
      assert.throws(() => brewerSettingsOf(given({ orderText: 'plan' })), /--order-text/);
      assert.throws(() => brewerSettingsOf(given({ setups: 'reads' })), /--setups/);
    });

    it("a Taster's --model takes a level or a model id, and refuses anything else", () => {
      assert.throws(() => brewerSettingsOf(given({ model: 'Opus 5' })), /--model.*"Opus 5"/);
      assert.throws(() => brewerSettingsOf(given({ model: undefined })), /--model/);
      assert.throws(() => brewerSettingsOf(given({ effort: 'high' })), /--effort.*"high"/);
    });

    it('names a setup per order by all four settings, of the orders --orders names', () => {
      assert.deepEqual(tasterSetups(ON_ID), [
        '855-taster-claude-opus-5-5-full-together-bare',
        '864-taster-claude-opus-5-5-full-together-bare',
        '867-taster-claude-opus-5-5-full-together-bare',
      ]);
      assert.deepEqual(tasterSetups(ON_LEVEL, '867'), ['867-taster-strong-larger-apart-reads']);
    });
  });

  describe('the recipe and the Taster', () => {
    it('a run on a level tastes on that level and the effort asked, with no models.jsonc of its own', () => {
      assert.equal(tasterBreweryFiles(ON_LEVEL, TASTERS)['models.jsonc'], undefined);
      const line = commandLine(ON_LEVEL, 'acceptance');
      assert.equal(optionValue(line, '--model'), 'opus');
      assert.equal(optionValue(line, '--effort'), 'high');
      const light = commandLine({ ...ON_LEVEL, model: 'light', effort: 'small' }, 'security');
      assert.equal(optionValue(light, '--model'), 'haiku');
      assert.equal(optionValue(light, '--effort'), 'low');
    });

    it("a run on a model id tastes on that id through models.jsonc's strong, and moves no other brewer", () => {
      const line = commandLine(ON_ID, 'together');
      assert.equal(optionValue(line, '--model'), 'claude-opus-5-5');
      assert.equal(optionValue(line, '--effort'), 'xhigh');
      assert.equal(optionValue(commandLine(ON_ID, 'implement'), '--model'), 'sonnet');
    });

    it('apart gives one Taster per lens', () => {
      const taste = tasteStepOf(ON_LEVEL);
      const parallel = taste.parallel as Record<string, unknown>[];
      assert.deepEqual(
        parallel.map(({ id, lens, model, effort }) => ({ id, lens, model, effort })),
        ['correctness', 'acceptance', 'security'].map((id) => ({
          id,
          lens: `diff/${id}`,
          model: 'strong',
          effort: 'larger',
        })),
      );
    });

    it('together gives one Taster for all three lenses', () => {
      const taste = tasteStepOf(ON_ID);
      assert.equal(taste.parallel, undefined);
      assert.equal(taste.id, 'together');
      assert.deepEqual(taste.lenses, ['diff/correctness', 'diff/acceptance', 'diff/security']);
      assert.equal(taste.model, 'strong');
      assert.equal(taste.effort, 'full');
    });

    it('reads tastes with the Taster that reads the rules, and bare with its cut', () => {
      assert.equal(
        tasterBreweryFiles(ON_LEVEL, TASTERS)['brewers/taster.md'],
        withoutLevels(READS),
      );
      assert.equal(
        tasterBreweryFiles({ ...ON_LEVEL, rules: 'bare' }, TASTERS)['brewers/taster.md'],
        withoutLevels(bareTaster(READS)),
      );
    });

    it('the dry run plays every Taster step of either recipe', () => {
      const scripted = Object.keys(scriptedRealTastings('src/a.ts'));
      for (const settings of [ON_LEVEL, ON_ID]) {
        const taste = tasteStepOf(settings);
        const ids = Array.isArray(taste.parallel)
          ? (taste.parallel as { id: string }[]).map(({ id }) => id)
          : [taste.id as string];
        for (const id of ids) assert.ok(scripted.includes(id), id);
      }
    });
  });

  describe('the model stop', () => {
    const DEFAULTS = parseJsonc(readFileSync(join(root, 'defaults', 'models.jsonc'), 'utf8')) as {
      claude: { models: Record<string, string> };
    };
    const families = Object.entries(DEFAULTS.claude.models);

    it("a run on a level asks for that level's default family, as defaults/models.jsonc names it", () => {
      assert.equal(families.length, 4);
      for (const [level, family] of families) {
        const other = families.find(([, each]) => each !== family)?.[1] ?? '';
        const settings = { ...ON_LEVEL, model: level };
        const on = (model: string) => modelStop(settingsRecord(settings, 855, 1, model));
        assert.equal(on(`claude-${family}-5-5`), undefined, level);
        assert.match(on(`claude-${other}-5-5`) ?? '', new RegExp(`asks for ${family}`), level);
      }
    });

    it('a run on a model id stops on any other id, one of its own family too', () => {
      const on = (model: string) => modelStop(settingsRecord(ON_ID, 864, 1, model));
      assert.equal(on('claude-opus-5-5'), undefined);
      assert.equal(on('claude-opus-5-5-20261101'), undefined);
      assert.match(on('claude-opus-5-6') ?? '', /claude-opus-5-6.*asks for claude-opus-5-5/);
      assert.match(on('claude-sonnet-5-5') ?? '', /claude-sonnet-5-5/);
    });

    it("a settings run's record keeps its settings, which its stop asks by", () => {
      const events = [
        {
          event: {
            type: 'step.started',
            batchId: '1-1',
            stepId: 'together',
            attempt: 1,
            session: { id: 'session-together', worktree: 'w' },
          } as unknown as Event,
        },
        {
          event: {
            type: 'step.finished',
            batchId: '1-1',
            stepId: 'together',
            attempt: 1,
            outcome: { kind: 'succeeded', output: { findings: [] } },
          } as unknown as Event,
        },
      ];
      const record = realRecordOf(
        events,
        () => scriptedTranscript('w', 'claude-sonnet-5-5'),
        ON_ID,
      );
      assert.deepEqual(record.taster, ON_ID);
      const setup = tasterSetups(ON_ID)[0] ?? '855-taster-';
      assert.match(modelStop({ ...record, setup }) ?? '', /asks for claude-opus-5-5/);
    });
  });

  describe('the lists and codes.md', () => {
    it('the lists show none of the settings, and codes.md shows all four with the model each Taster ran on', () => {
      const { lists, codes } = blinded([fixed, settings], 'a seed');
      assert.doesNotMatch(lists['855'] ?? '', /taster-|claude-|full|bare|together/);
      assert.match(
        codes,
        /\| 855-taster-claude-opus-5-5-full-together-bare \| 1 \| together \| claude-opus-5-5-20261101 \|/,
      );
      // Two runs to score: the settings run is in the list, under its own code.
      assert.match(lists['855'] ?? '', /2 runs to score/);
    });

    it("the table counts a settings setup's runs after every fixed setup's row", () => {
      const rows = realTable([fixed, settings]).split('\n');
      const fixedRows = realTable([fixed]).split('\n');
      const at = rows.findIndex((row) => row.startsWith('| 855-taster-'));
      assert.equal(
        rows[at],
        '| 855-taster-claude-opus-5-5-full-together-bare | 1 | 0 | 0 | 0 of 1 |',
      );
      assert.deepEqual(rows.slice(0, at), fixedRows.slice(0, at));
      assert.deepEqual(rows.slice(at + 1), fixedRows.slice(at));
    });

    it('the table lists each settings setup once, in the order its runs first came, below every fixed setup', () => {
      const other = { ...ON_LEVEL, model: 'light' };
      const rows = realTable([
        settingsRecord(other, 867, 1, 'claude-haiku-5-5'),
        settings,
        settingsRecord(other, 867, 2, 'claude-haiku-5-5'),
        fixed,
        settingsRecord(ON_ID, 855, 2, 'claude-opus-5-5'),
      ]).split('\n');
      const setups = rows.map((row) => row.split(' | ')[0]?.slice(2));
      assert.deepEqual(
        setups.filter((setup) => setup?.includes('-taster-')),
        ['867-taster-light-larger-apart-reads', '855-taster-claude-opus-5-5-full-together-bare'],
      );
      const first = setups.findIndex((setup) => setup?.includes('-taster-'));
      for (const setup of REAL_SETUPS) assert.ok(setups.indexOf(setup) < first, setup);
    });
  });

  describe('the fixed profiles', () => {
    it("every fixed setup's recipe and Brewery files are as they were: regression test", () => {
      const all = REAL_SETUPS.map((setup) => [
        setup,
        realRecipeOf(setup),
        realBreweryFiles(setup, TASTERS),
      ]);
      // The digest of main's files before ADR 0402, which a fixed profile's run keeps.
      assert.equal(
        createHash('sha256').update(JSON.stringify(all)).digest('hex'),
        '73a4a515287598d94570a780ea4d33cbedb4a83b1f97cf9977cf377e1bd0d542',
      );
    });

    it("a fixed profile's list and codes rows stay as they were beside a settings run: regression test", () => {
      const alone = blinded([fixed], 'a seed');
      const beside = blinded([fixed, settingsRecord(ON_ID, 855, 1, 'claude-opus-5-5')], 'a seed');
      // The fixed run's whole block is one of the blocks of its order's list beside the settings run's.
      const blocks = (list = '') =>
        list
          .split('\n## Run ')
          .slice(1)
          .map((each) => each.trimEnd());
      const [block] = blocks(alone.lists['855']);
      assert.ok(block !== undefined, alone.lists['855']);
      assert.equal(blocks(beside.lists['855']).length, 2);
      assert.ok(blocks(beside.lists['855']).includes(block), beside.lists['855']);
      for (const row of alone.codes.split('\n').filter((line) => line.startsWith('| '))) {
        assert.ok(beside.codes.includes(row), row);
      }
    });
  });
});
