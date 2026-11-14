import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { BREWERY, localConfig, TARGET, USER } from '../../scripts/demo/core.ts';
import {
  type BrewerRecord,
  type BrewerSettings,
  brewerBlinded,
  brewerBreweryFiles,
  brewerFailure,
  brewerRecipeText,
  brewerRecordOf,
  brewerScript,
  brewerSettingsOf,
  brewerSetups,
  brewerStop,
  brewerTable,
  codeDiffArgs,
  codeOf,
  nextBrewerRun,
  REAL_BREWER_RECIPE,
  REAL_SETUPS,
  realBreweryFiles,
  scratchNameOf,
  scriptedTranscript,
  splitHead,
} from '../../scripts/tasting-compare/real.ts';
import { modelOf } from '../../src/brewers/attempt-plan.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';
import type { Event } from '../../src/schemas/events.ts';
import { Recipe } from '../../src/schemas/recipe.ts';
import { nipBreweryFiles } from '../helpers/nip-fixture.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const OPUS: BrewerSettings = { brewer: 'cellarman', model: 'claude-opus-5-5', effort: 'xhigh' };
const NAMES = { brewery: BREWERY, target: TARGET, user: USER };
const SESSION = '00000000-0000-4000-8000-000000000001';

/** The Brewery of a brewer's run, written to a scratch folder, and serve's own setup of it. */
const withBrewery = <T>(
  settings: BrewerSettings,
  use: (ready: ReturnType<typeof serveSetup>, files: Record<string, string>) => T,
): T => {
  const brewery = makeTempDir('tasting-compare-real-brewer');
  try {
    const { 'models.jsonc': _, ...nip } = nipBreweryFiles(NAMES);
    const files: Record<string, string> = {
      ...nip,
      ...brewerBreweryFiles(settings, NAMES),
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
    return use(ready, files);
  } finally {
    brewery.remove();
  }
};

/** A step's `claude` line in a brewer's run, through serve's own setup. */
const commandLine = (settings: BrewerSettings, stepId: string): string[] =>
  withBrewery(settings, (ready) => {
    assert.ok(ready.kind !== 'refused', JSON.stringify(ready));
    const step = ready.setup.brewers.find(REAL_BREWER_RECIPE, stepId);
    assert.ok(step !== undefined, stepId);
    return claudeArgs({
      model: modelOf(ready.setup.models, step.brewer),
      effort: step.brewer.effort,
      settingsFile: 'settings.json',
      tools: ['Read'],
      session: { kind: 'new', id: SESSION },
    });
  });

const optionValue = (line: readonly string[], option: string): string | undefined =>
  line[line.indexOf(option) + 1];

const HEAD = {
  head: 'f4fb4585',
  subject: 'Name the mashed order in the merge brief',
  tests: { 'test/unit/driver.test.ts': 'the test', 'test/helpers/fake.ts': 'the helper' },
  code: { 'src/engine/driver.ts': 'the code' },
};

/** An event of a run's store, with only the fields the record reads. */
const event = (fields: Record<string, unknown>) => ({ event: fields as unknown as Event });
const started = (stepId: string, attempt: number, more: Record<string, unknown> = {}) =>
  event({ type: 'step.started', batchId: '1-1', stepId, attempt, ...more });
const finished = (stepId: string, attempt: number, more: Record<string, unknown> = {}) =>
  event({
    type: 'step.finished',
    batchId: '1-1',
    stepId,
    attempt,
    outcome: { kind: 'succeeded', output: {} },
    ...more,
  });
const session = (id: string) => ({ session: { id, worktree: `work-${id}` } });
const worktree = (commit: string) => ({
  worktree: { repo: TARGET, path: 'w', branch: 'b', commit },
});
const usage = (input: number) => ({
  inputTokens: input,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
});
const exited = (check: string, exitCode: number) => ({
  result: 'exited',
  check,
  command: `npm run ${check}`,
  exitCode,
  tail: '',
});
const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);

/**
 * A run whose Cellarman wrote code twice: the green step failed the first and passed the second,
 * each Cellarman attempt in a session of its own.
 */
const twoRounds = [
  started('gauge', 1, session('gauge-1')),
  finished('gauge', 1),
  started('implement', 1, session('implement-1')),
  finished('implement', 1, {
    usage: usage(10),
    receipt: { turns: 7, durationMs: 1_000 },
  }),
  started('green', 1, worktree(FIRST)),
  finished('green', 1, {
    outcome: { kind: 'failed', retryable: false, reason: 'test failed' },
    readings: [exited('typecheck', 0), exited('test', 1)],
  }),
  started('implement', 2, session('implement-2')),
  finished('implement', 2, {
    usage: usage(20),
    receipt: { turns: 3, durationMs: 500 },
  }),
  started('green', 2, worktree(SECOND)),
  finished('green', 2, { readings: [exited('typecheck', 0), exited('test', 0)] }),
  event({ type: 'batch.on_tap', batchId: '1-1', pullRequests: [] }),
];

const opusTranscript = (_id: string, tree: string) => scriptedTranscript(tree, 'claude-opus-5-5');

const brewerRecord = (
  setup: BrewerRecord['setup'],
  run: number,
  more: Partial<BrewerRecord['brewer']> = {},
): BrewerRecord => ({
  setup,
  run,
  ended: 'on_tap',
  wallMs: 9_000,
  attempts: [],
  brewer: {
    ...OPUS,
    checksPassed: true,
    checks: ['test: exited 0'],
    steps: [{ stepId: 'implement', attempts: 1, usage: usage(10), turns: 7, durationMs: 1_000 }],
    models: ['claude-opus-5-5'],
    commit: SECOND,
    diff: `diff --git a/src/a.ts b/src/a.ts\n+the code of ${setup} run ${run}`,
    ...more,
  },
});

/** `record` with no commit: its Cellarman left no code the checks read. */
const withoutCommit = (record: BrewerRecord): BrewerRecord => {
  const { commit: _, ...brewer } = record.brewer;
  return { ...record, brewer };
};

describe('tasting-compare --real --brewer (ADR 0394)', () => {
  describe('the options', () => {
    it('--brewer cellarman with a model and an effort gives the settings of a real Cellarman', () => {
      assert.deepEqual(
        brewerSettingsOf({
          real: true,
          brewer: 'cellarman',
          model: 'claude-opus-5-5',
          effort: 'xhigh',
        }),
        OPUS,
      );
    });

    it('without --brewer, --model or --effort there is no brewer run', () => {
      assert.equal(brewerSettingsOf({ real: true }), undefined);
    });

    it('--brewer without --real is refused', () => {
      assert.throws(
        () => brewerSettingsOf({ brewer: 'cellarman', model: 'opus', effort: 'high' }),
        /--brewer.*--real/,
      );
    });

    it('--model or --effort without --brewer is refused', () => {
      assert.throws(() => brewerSettingsOf({ real: true, model: 'opus' }), /--brewer/);
      assert.throws(() => brewerSettingsOf({ real: true, effort: 'high' }), /--brewer/);
    });

    it('--brewer without a model or an effort is refused', () => {
      assert.throws(
        () => brewerSettingsOf({ real: true, brewer: 'cellarman', effort: 'high' }),
        /--model/,
      );
      assert.throws(
        () => brewerSettingsOf({ real: true, brewer: 'cellarman', model: 'opus' }),
        /--effort/,
      );
    });

    it('a model id models.jsonc refuses stops the run before anything is brewed', () => {
      assert.throws(
        () =>
          brewerSettingsOf({ real: true, brewer: 'cellarman', model: 'Opus 5', effort: 'high' }),
        /--model.*"Opus 5"/,
      );
    });

    it('an effort the brewers do not know is refused', () => {
      assert.throws(
        () =>
          brewerSettingsOf({ real: true, brewer: 'cellarman', model: 'opus', effort: 'highest' }),
        /--effort.*"highest"/,
      );
    });

    it('a brewer it does not run for real is refused, and the Gauger is not one', () => {
      assert.throws(
        () => brewerSettingsOf({ real: true, brewer: 'gauger', model: 'opus', effort: 'high' }),
        /--brewer.*cellarman.*"gauger"/,
      );
    });

    it('--setups with --brewer is refused: a brewer run is no Taster setup', () => {
      assert.throws(
        () =>
          brewerSettingsOf({
            real: true,
            brewer: 'cellarman',
            model: 'opus',
            effort: 'high',
            setups: 'reads',
          }),
        /--setups.*--brewer/,
      );
    });

    it('names a setup per order by its brewer, model and effort, of the orders --orders names', () => {
      assert.deepEqual(brewerSetups(OPUS), [
        '855-cellarman-claude-opus-5-5-xhigh',
        '864-cellarman-claude-opus-5-5-xhigh',
        '867-cellarman-claude-opus-5-5-xhigh',
      ]);
      assert.deepEqual(brewerSetups(OPUS, '867,855'), [
        '855-cellarman-claude-opus-5-5-xhigh',
        '867-cellarman-claude-opus-5-5-xhigh',
      ]);
      assert.throws(() => brewerSetups(OPUS, '999'), /--orders.*"999"/);
    });

    it("a run's scratch folder holds no character Windows refuses in a folder's name", () => {
      assert.equal(
        scratchNameOf('855-cellarman-claude-opus-5-5[1m]:x-high-1'),
        '855-cellarman-claude-opus-5-5_1m__x-high-1',
      );
      assert.equal(scratchNameOf('855-reads-1'), '855-reads-1');
    });
  });

  describe('the recipe', () => {
    it("--brewer cellarman gives a recipe whose Cellarman is real on the given model and effort, and whose Gauger's step comes first", () => {
      const recipe = Recipe.parse(parseJsonc(brewerRecipeText(OPUS)));
      assert.equal(recipe.name, REAL_BREWER_RECIPE);
      assert.equal(recipe.testFirst, false);
      assert.deepEqual(
        recipe.steps.map((step) => ('action' in step ? step.action : step.id)),
        ['gauge', 'implement', 'green', 'openPullRequest'],
      );
      const line = commandLine(OPUS, 'implement');
      assert.equal(optionValue(line, '--model'), 'claude-opus-5-5');
      assert.equal(optionValue(line, '--effort'), 'xhigh');
    });

    it('moves no other brewer: the Gauger stays on its own model and effort', () => {
      const line = commandLine(OPUS, 'gauge');
      assert.equal(optionValue(line, '--model'), 'sonnet');
      assert.equal(optionValue(line, '--effort'), 'high');
    });

    it('a second model and effort move only the Cellarman', () => {
      const line = commandLine(
        { ...OPUS, model: 'claude-sonnet-5-5', effort: 'medium' },
        'implement',
      );
      assert.equal(optionValue(line, '--model'), 'claude-sonnet-5-5');
      assert.equal(optionValue(line, '--effort'), 'medium');
    });

    it("its checks run on Cellarman's code and send it back once, and its Brewery loads", () => {
      const recipe = Recipe.parse(parseJsonc(brewerRecipeText(OPUS)));
      const green = recipe.steps.find((step) => 'id' in step && step.id === 'green');
      assert.ok(green !== undefined && 'check' in green);
      assert.deepEqual(green.check, ['build', 'typecheck', 'lint', 'format', 'test']);
      assert.deepEqual(green.onFail, { goto: 'implement', maxRounds: 1 });
      withBrewery(OPUS, (ready) => assert.ok(ready.kind !== 'refused', JSON.stringify(ready)));
      withBrewery(OPUS, (_ready, files) => {
        const brewery = makeTempDir('tasting-compare-real-brewer');
        try {
          for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(brewery.path, path)), { recursive: true });
            writeFileSync(join(brewery.path, path), text);
          }
          const loaded = loadRecipes(readBreweryFiles(brewery.path));
          assert.deepEqual(loaded.valid ? [] : loaded.problems, []);
        } finally {
          brewery.remove();
        }
      });
    });

    it("the target installs its dependencies and runs the repository's own checks", () => {
      const config = JSON.parse(brewerBreweryFiles(OPUS, NAMES)['foedrum.jsonc'] ?? '{}');
      assert.deepEqual(config.repositories[TARGET], {
        setup: { command: 'npm ci', timeout: '10m' },
        checks: {
          build: null,
          typecheck: 'npm run typecheck',
          lint: 'npm run lint',
          format: null,
          test: 'npm run check',
        },
      });
      assert.deepEqual(config.users, [USER]);
      assert.equal(config.brewery, BREWERY);
    });

    it("an existing setup's recipe and Brewery files are unchanged: no checks of its own, no model moved: regression test", () => {
      const reads = readFileSync(
        join(import.meta.dirname, '..', 'fixtures', 'tasting-compare', 'real', 'taster-reads.md'),
        'utf8',
      );
      const tasters = { today: 'the old text', reads };
      for (const setup of REAL_SETUPS) {
        const files = realBreweryFiles(setup, tasters);
        assert.equal(files['foedrum.jsonc'], undefined, setup);
        assert.doesNotMatch(files['models.jsonc'] ?? '', /measured/, setup);
        assert.doesNotMatch(Object.values(files).join('\n'), /"check"/, setup);
      }
    });
  });

  describe('the scripted brewers', () => {
    it("the Gauger's step commits only the head's test files, and Cellarman is not scripted", () => {
      const script = brewerScript(HEAD, false);
      assert.deepEqual(Object.keys(script), ['gauge']);
      const [gauge] = script.gauge ?? [];
      assert.deepEqual(gauge?.files, HEAD.tests);
      assert.match(gauge?.summary ?? '', /test\/unit\/driver\.test\.ts/);
    });

    it("--dry-run shows a Cellarman run with no token spent: Cellarman commits the head's code as brewed", () => {
      const script = brewerScript(HEAD, true);
      assert.deepEqual(script.gauge?.[0]?.files, HEAD.tests);
      assert.deepEqual(script.implement?.[0]?.files, HEAD.code);
      assert.equal(script.implement?.[0]?.message, HEAD.subject);
    });

    it('splits a head into its test files and the rest', () => {
      assert.deepEqual(
        splitHead(['src/a.ts', 'test/unit/a.test.ts', 'docs/adr/x.md', 'test/helpers/h.ts']),
        {
          tests: ['test/unit/a.test.ts', 'test/helpers/h.ts'],
          code: ['src/a.ts', 'docs/adr/x.md'],
        },
      );
    });

    it('refuses a head with no test file, or with nothing but tests: no run would start from failing tests', () => {
      assert.throws(() => splitHead(['src/a.ts']), /no test file/);
      assert.throws(() => splitHead(['test/unit/a.test.ts']), /nothing but tests/);
    });
  });

  describe("a run's record", () => {
    it('a run records whether the checks passed, the rounds, tokens and time per step, and the commit it ended on', () => {
      const { ended, attempts, brewer } = brewerRecordOf(twoRounds, OPUS, opusTranscript);
      assert.equal(ended, 'on_tap');
      assert.deepEqual(attempts, []);
      assert.equal(brewer.checksPassed, true);
      assert.deepEqual(brewer.checks, ['typecheck: exited 0', 'test: exited 0']);
      assert.equal(brewer.commit, SECOND);
      assert.deepEqual(brewer.steps, [
        { stepId: 'gauge', attempts: 1, turns: 0, durationMs: 0 },
        {
          stepId: 'implement',
          attempts: 2,
          usage: { inputTokens: 30, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8 },
          turns: 10,
          durationMs: 1_500,
        },
        { stepId: 'green', attempts: 2, turns: 0, durationMs: 0 },
      ]);
      assert.deepEqual(brewer.models, ['claude-opus-5-5']);
      assert.equal(brewer.model, OPUS.model);
      assert.equal(brewer.effort, OPUS.effort);
    });

    it('a run whose last checks failed records them failed, with the commit they read', () => {
      const failedAgain = [
        ...twoRounds.slice(0, -2),
        finished('green', 2, {
          outcome: { kind: 'failed', retryable: false, reason: 'test failed' },
          readings: [exited('test', 1)],
        }),
        event({
          type: 'batch.stuck',
          batchId: '1-1',
          reason: { kind: 'attempts_exhausted', stepId: 'green' },
        }),
      ];
      const { ended, brewer } = brewerRecordOf(failedAgain, OPUS, opusTranscript);
      assert.equal(ended, 'stuck: attempts_exhausted');
      assert.equal(brewer.checksPassed, false);
      assert.deepEqual(brewer.checks, ['test: exited 1']);
      assert.equal(brewer.commit, SECOND);
      assert.equal(brewerFailure({ ended, brewer }), undefined);
    });

    it('reads the model of each Cellarman session from its own transcript', () => {
      const { brewer } = brewerRecordOf(twoRounds, OPUS, (id, tree) =>
        scriptedTranscript(tree, id === 'implement-2' ? 'claude-sonnet-5-5' : 'claude-opus-5-5'),
      );
      assert.deepEqual(brewer.models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
      assert.match(
        brewerStop({ setup: '855-cellarman-claude-opus-5-5-xhigh', brewer }) ?? '',
        /claude-sonnet-5-5/,
      );
    });

    it('a run on the model it asked for stops nothing', () => {
      const { brewer } = brewerRecordOf(twoRounds, OPUS, opusTranscript);
      assert.equal(brewerStop({ setup: '855-cellarman-claude-opus-5-5-xhigh', brewer }), undefined);
    });

    it('a family asks for any model of it', () => {
      const { brewer } = brewerRecordOf(twoRounds, { ...OPUS, model: 'opus' }, opusTranscript);
      assert.equal(brewerStop({ setup: '855-cellarman-opus-xhigh', brewer }), undefined);
    });

    it('an id asks for itself: one whose name starts another id does not accept that other model', () => {
      const asked = { ...OPUS, model: 'claude-opus-5' };
      const { brewer } = brewerRecordOf(twoRounds, asked, opusTranscript);
      assert.match(
        brewerStop({ setup: '855-cellarman-claude-opus-5-xhigh', brewer }) ?? '',
        /claude-opus-5-5.*asks for claude-opus-5/,
      );
    });

    it('an id accepts a dated snapshot of itself: regression test', () => {
      const dated = (_id: string, tree: string) =>
        scriptedTranscript(tree, 'claude-opus-5-5-20261101');
      const { brewer } = brewerRecordOf(twoRounds, OPUS, dated);
      assert.equal(brewerStop({ setup: '855-cellarman-claude-opus-5-5-xhigh', brewer }), undefined);
    });

    it('a Cellarman whose transcript cannot be found stops the comparison', () => {
      const { brewer } = brewerRecordOf(twoRounds, OPUS, () => undefined);
      assert.match(
        brewerStop({ setup: '855-cellarman-claude-opus-5-5-xhigh', brewer }) ?? '',
        /transcript/,
      );
    });

    it('a run whose Cellarman left no code the checks read measured nothing', () => {
      const lost = [
        started('gauge', 1),
        finished('gauge', 1),
        started('implement', 1, session('implement-1')),
        finished('implement', 1, {
          outcome: { kind: 'failed', retryable: false, reason: 'no out doc' },
        }),
        event({ type: 'batch.stuck', batchId: '1-1', reason: { kind: 'attempts_exhausted' } }),
      ];
      const { ended, brewer } = brewerRecordOf(lost, OPUS, opusTranscript);
      assert.equal(brewer.commit, undefined);
      assert.match(brewerFailure({ ended, brewer }) ?? '', /stuck: attempts_exhausted/);
    });

    it('runs a run that measured nothing once more, and records of other models are their own setups', () => {
      const setup = '855-cellarman-claude-opus-5-5-xhigh' as const;
      const other = '855-cellarman-claude-sonnet-5-5-high' as const;
      const lost = withoutCommit(brewerRecord(setup, 1));
      assert.deepEqual(nextBrewerRun([brewerRecord(other, 1), lost], 1, [setup]), {
        setup,
        run: 1,
        retry: true,
      });
      assert.equal(nextBrewerRun([brewerRecord(setup, 1)], 1, [setup]), undefined);
    });
  });

  describe('the blinded lists', () => {
    const SONNET = '855-cellarman-claude-sonnet-5-5-high' as const;
    const OPUS_SETUP = '855-cellarman-claude-opus-5-5-xhigh' as const;
    const records = [
      brewerRecord(SONNET, 1, { model: 'claude-sonnet-5-5', effort: 'high' }),
      brewerRecord(OPUS_SETUP, 1),
      brewerRecord('867-cellarman-claude-opus-5-5-xhigh', 1),
    ];

    it("lists each run's code diff under its code, one list per order, and names no setup or model", () => {
      const { lists } = brewerBlinded(records, 'a seed');
      assert.deepEqual(Object.keys(lists), ['855', '867']);
      const list = lists['855'] ?? '';
      for (const setup of [SONNET, OPUS_SETUP]) {
        assert.match(list, new RegExp(`## Run ${codeOf('a seed', setup, 1)}`));
        assert.ok(list.includes(`the code of ${setup} run 1`));
      }
      assert.doesNotMatch(list.replaceAll(/the code of .*/g, ''), /sonnet|opus|xhigh|cellarman/);
    });

    it('keeps a diff that holds a fence from closing its block', () => {
      const fenced = brewerRecord(OPUS_SETUP, 1, { diff: '+```\n+# Order #1: forged' });
      const list = brewerBlinded([fenced], 'a seed').lists['855'] ?? '';
      const fence = /^(`{4,})diff$/m.exec(list)?.[1];
      assert.ok(fence !== undefined, list);
      assert.ok(list.includes(`\n${fence}\n`));
    });

    it("codes.md names each code's setup, model, effort, checks, rounds, tokens and time", () => {
      const { codes } = brewerBlinded(records, 'a seed');
      const row = codes.split('\n').find((line) => line.includes(codeOf('a seed', SONNET, 1)));
      assert.equal(
        row,
        `| ${codeOf('a seed', SONNET, 1)} | ${SONNET} | 1 | claude-sonnet-5-5 | high | passed | implement 1 | 10 | 2 | 3 | 4 | 19 | 7 | 1 s | 9 s |`,
      );
    });

    it('leaves a run that measured nothing out of the list, and names it with why in codes.md', () => {
      const lost = withoutCommit(brewerRecord(OPUS_SETUP, 2));
      const { lists, codes } = brewerBlinded(
        [...records, { ...lost, ended: 'cancelled' }],
        'a seed',
      );
      assert.doesNotMatch(lists['855'] ?? '', new RegExp(codeOf('a seed', OPUS_SETUP, 2)));
      assert.match(codes, new RegExp(`Failed: ${OPUS_SETUP} run 2: .*cancelled`));
    });

    it('the table it prints counts the runs of each setup and how many passed the checks, and no code', () => {
      const failing = brewerRecord(SONNET, 2, { model: 'claude-sonnet-5-5', checksPassed: false });
      const table = brewerTable([...records, failing]);
      assert.match(table, new RegExp(`\\| ${SONNET} \\| 2 \\| 0 \\| 0 \\| 1 of 2 \\|`));
      assert.match(table, new RegExp(`\\| ${OPUS_SETUP} \\| 1 \\| 0 \\| 0 \\| 1 of 1 \\|`));
      assert.doesNotMatch(table, new RegExp(codeOf('a seed', SONNET, 1)));
    });
  });

  describe('what the first review found untested', () => {
    const SETUP = '855-cellarman-claude-opus-5-5-xhigh' as const;

    it("reads no transcript but Cellarman's: the scripted Gauger's session has none", () => {
      const { brewer } = brewerRecordOf(twoRounds, OPUS, (id, tree) =>
        id === 'gauge-1' ? undefined : scriptedTranscript(tree, 'claude-opus-5-5'),
      );
      assert.equal(brewer.unreadable, undefined);
      assert.equal(brewerStop({ setup: SETUP, brewer }), undefined);
    });

    it('a list shows its runs in code order, whatever order their records came in', () => {
      const setups = ['a', 'b', 'c', 'd', 'e'].map(
        (model) => `855-cellarman-${model}-high` as const,
      );
      const code = (setup: string) => codeOf('a seed', setup, 1);
      const records = setups
        .map((setup) => brewerRecord(setup, 1))
        .sort((a, b) => (code(a.setup) < code(b.setup) ? 1 : -1));
      const list = brewerBlinded(records, 'a seed').lists['855'] ?? '';
      const shown = [...list.matchAll(/^## Run (\w+)$/gm)].map(([, each]) => each);
      assert.notDeepEqual(
        records.map(({ setup }) => code(setup)),
        shown,
      );
      assert.deepEqual(shown, [...shown].sort());
      assert.equal(shown.length, setups.length);
    });

    it('a model asked with [1m] accepts the name its transcript gives, which has none', () => {
      const { brewer } = brewerRecordOf(
        twoRounds,
        { ...OPUS, model: 'claude-opus-5-5[1m]' },
        opusTranscript,
      );
      assert.equal(brewerStop({ setup: SETUP, brewer }), undefined);
    });

    it("the code's diff leaves out the folder of the test files the scripted Gauger commits", () => {
      const args = codeDiffArgs('base-sha', 'end-sha');
      assert.deepEqual(args, [
        'diff',
        '--no-renames',
        'base-sha',
        'end-sha',
        '--',
        '.',
        ':(exclude)test/',
      ]);
      const excluded = (args.at(-1) ?? '').slice(':(exclude)'.length);
      const { tests } = splitHead(['src/a.ts', 'test/unit/a.test.ts', 'test/helpers/h.ts']);
      assert.ok(tests.every((path) => path.startsWith(excluded)));
    });

    it('the table counts the failed goes and the retries of a setup', () => {
      const SONNET = '855-cellarman-claude-sonnet-5-5-high' as const;
      const lost = { ...withoutCommit(brewerRecord(SONNET, 2)), ended: 'cancelled' };
      const again = { ...brewerRecord(SONNET, 2), retry: true as const };
      const table = brewerTable([brewerRecord(SONNET, 1), lost, again]);
      assert.match(table, new RegExp(`\\| ${SONNET} \\| 2 \\| 1 \\| 1 \\| 2 of 2 \\|`));
    });

    it("records each reading of the last green attempt by what ended it, the setup's by its name", () => {
      const readings = [
        { result: 'exited', setup: true, command: 'npm ci', exitCode: 0, tail: '' },
        { result: 'skipped', check: 'build' },
        { result: 'unstarted', check: 'typecheck', command: 'npm run typecheck', tail: '' },
        { result: 'signaled', check: 'lint', command: 'npm run lint', signal: 'SIGKILL', tail: '' },
        {
          result: 'killed',
          check: 'test',
          command: 'npm run check',
          killed: 'timed-out',
          tail: '',
        },
      ];
      const events = [
        ...twoRounds.slice(0, -2),
        finished('green', 2, {
          outcome: { kind: 'failed', retryable: false, reason: 'the checks failed' },
          readings,
        }),
      ];
      assert.deepEqual(brewerRecordOf(events, OPUS, opusTranscript).brewer.checks, [
        'setup: exited 0',
        'build: skipped',
        'typecheck: unstarted',
        'lint: ended on SIGKILL',
        'test: killed, timed-out',
      ]);
    });
  });
});
