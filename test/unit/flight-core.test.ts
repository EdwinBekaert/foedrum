import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BREWERY, TARGET, USER } from '../../scripts/demo/core.ts';
import {
  askedModels,
  dryRunScript,
  type FlightRecord,
  type FlightSettings,
  type FlightValues,
  flightBreweryFiles,
  flightFailure,
  flightFolderOf,
  flightOptionsOf,
  flightRecordOf,
  flightStop,
  flightTable,
  headOf,
  hiddenOf,
  nextFlightRun,
  outsidePaths,
} from '../../scripts/flight/core.ts';
import { type FlightOrder, readOrder } from '../../scripts/flight-orders.ts';
import { scriptedTranscript } from '../../scripts/tasting-compare/real.ts';
import { TEST_MAP_PATH } from '../../src/checks/test-map.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { pushKey } from '../../src/engine/pull-request.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';
import type { Event } from '../../src/schemas/events.ts';
import { Recipe } from '../../src/schemas/recipe.ts';

const DEFAULTS = join(import.meta.dirname, '..', '..', 'defaults', 'recipes');
const recipeText = (name: string): string | undefined => {
  try {
    return readFileSync(join(DEFAULTS, `${name}.jsonc`), 'utf8');
  } catch {
    return undefined;
  }
};
const NIP = recipeText('nip') ?? '';
const DEEP = recipeText('deep-brew') ?? '';
const NAMES = { brewery: BREWERY, target: TARGET, user: USER };

/**
 * A recipe whose Tasters name every level beside its Cellarman, for the refusal of a model id for
 * Cellarman with no level free.
 */
const EVERY_LEVEL = JSON.stringify({
  name: 'every-level',
  type: 'brew',
  description: 'Names every level',
  steps: [
    { id: 'implement', brewer: 'cellarman', model: 'standard', effort: 'moderate' },
    ...['light', 'standard', 'strong', 'extreme'].map((model) => ({
      id: `taste-${model}`,
      brewer: 'taster',
      model,
      effort: 'moderate',
    })),
  ],
});
const withEveryLevel = (name: string) => (name === 'every-level' ? EVERY_LEVEL : recipeText(name));

const options = (values: FlightValues, texts = recipeText) => flightOptionsOf(values, texts);
const refusal = (values: FlightValues, texts = recipeText): string => {
  const read = options(values, texts);
  assert.equal(read.kind, 'refused', JSON.stringify(read));
  return read.kind === 'refused' ? read.message : '';
};

const SHIPPED: FlightSettings = { recipe: 'nip', runs: 3, dryRun: false };
const swapped = (model: string, recipe = 'nip', brewer = 'cellarman'): FlightSettings => ({
  ...SHIPPED,
  recipe,
  swap: { brewer, model, effort: 'full' },
});

/** The recipe's steps by id, children of a parallel group included, as the copy holds them. */
const stepsOf = (
  text: string,
): Map<string, { brewer?: string; model?: string; effort?: string }> => {
  const recipe = Recipe.parse(parseJsonc(text));
  const steps = new Map<string, { brewer?: string; model?: string; effort?: string }>();
  for (const step of recipe.steps) {
    for (const each of 'parallel' in step ? step.parallel : [step]) {
      if ('id' in each && each.id !== undefined) steps.set(each.id, each as { brewer?: string });
    }
  }
  return steps;
};
const copyOf = (files: Record<string, string>, recipe: string): string => {
  const text = files[`recipes/${recipe}.jsonc`];
  assert.ok(text !== undefined, Object.keys(files).join(', '));
  return text;
};
const mappedLevels = (files: Record<string, string>) => {
  const text = files['models.jsonc'];
  assert.ok(text !== undefined, 'no models.jsonc');
  return (parseJsonc(text) as { claude: { models: Record<string, string> } }).claude.models;
};

/** An order with a base, a solution that adds code and a test, and hidden tests. */
const ORDER: FlightOrder = readOrder('post-slugs', {
  'order.md': 'Give each post an address\n\nThe body.\n',
  'order.json': JSON.stringify({
    trap: { kind: 'edge-case', line: 'Punctuation.' },
    allowedPaths: ['src/', 'test/'],
  }),
  'base/package.json': '{}\n',
  'base/src/posts.mjs': 'export const posts = [];\n',
  'solution/src/posts.mjs': 'export const slugOf = (title) => title;\n',
  'solution/test/posts.test.mjs': "import 'node:test';\n",
  'hidden/test/hidden/slug.test.mjs': "import 'node:test';\n",
});

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
const greenRead = (commit: string) => ({
  worktree: { repo: TARGET, path: 'w', branch: 'b', commit },
});
const pushed = (round: number, commit: string) =>
  event({
    type: 'effect.applied',
    key: effectKey.encode(pushKey('1-1', round)),
    result: { branch: 'foedrum/1', commit, from: 'c'.repeat(40) },
  });
const usage = (input: number) => ({
  inputTokens: input,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
});
const GREEN_READ = 'a'.repeat(40);
const FIRST_PUSH = 'b'.repeat(40);
const SECOND_PUSH = 'd'.repeat(40);

/** Each session's transcript on a model, by the session's id. */
const transcripts =
  (models: Record<string, string>) =>
  (id: string, tree: string): string | undefined =>
    models[id] === undefined ? undefined : scriptedTranscript(tree, models[id]);

const record = (
  setup: string,
  run: number,
  flight: Partial<FlightRecord['flight']> = {},
  more: Partial<FlightRecord> = {},
): FlightRecord => ({
  setup,
  run,
  ended: 'on_tap',
  wallMs: 60_000,
  attempts: [],
  flight: {
    recipe: 'nip',
    head: GREEN_READ,
    headFrom: 'pull request',
    hidden: 'passed',
    changed: ['src/posts.mjs'],
    outside: [],
    steps: [{ stepId: 'implement', attempts: 1, usage: usage(10), turns: 4, durationMs: 20_000 }],
    models: { implement: ['claude-sonnet-5-5'] },
    ...flight,
  },
  ...more,
});

describe('the Flight (ADR 0409)', () => {
  describe('its options', () => {
    it('--recipe alone brews the recipe as it ships, 3 runs, on the real claude', () => {
      assert.deepEqual(options({ recipe: 'nip' }), { kind: 'flight', ...SHIPPED });
    });

    it('--runs and --dry-run are read', () => {
      assert.deepEqual(options({ recipe: 'nip', runs: '5', 'dry-run': true }), {
        kind: 'flight',
        ...SHIPPED,
        runs: 5,
        dryRun: true,
      });
    });

    it('a Flight with no --recipe is refused', () => {
      assert.match(refusal({}), /--recipe/);
    });

    it('a recipe that is not a default recipe is refused', () => {
      assert.match(refusal({ recipe: 'nipp' }), /"nipp"/);
    });

    it('--model without --brewer is refused', () => {
      assert.match(refusal({ recipe: 'nip', model: 'strong' }), /--model.*--brewer/);
    });

    it('--effort without --brewer is refused', () => {
      assert.match(refusal({ recipe: 'nip', effort: 'full' }), /--effort.*--brewer/);
    });

    it('--brewer without --model is refused', () => {
      assert.match(refusal({ recipe: 'nip', brewer: 'cellarman', effort: 'full' }), /--model/);
    });

    it('--brewer without --effort is refused', () => {
      assert.match(refusal({ recipe: 'nip', brewer: 'cellarman', model: 'strong' }), /--effort/);
    });

    it('a --brewer no step of the recipe names is refused', () => {
      assert.match(
        refusal({ recipe: 'nip', brewer: 'brewmaster', model: 'strong', effort: 'full' }),
        /brewmaster.*nip/,
      );
    });

    it('a --model that is neither a level nor an id is refused', () => {
      assert.match(
        refusal({ recipe: 'nip', brewer: 'cellarman', model: 'sonnet five', effort: 'full' }),
        /--model/,
      );
    });

    it('an --effort that is not one of the four is refused', () => {
      assert.match(
        refusal({ recipe: 'nip', brewer: 'cellarman', model: 'strong', effort: 'high' }),
        /--effort/,
      );
    });

    it('--runs below 1 or not whole is refused', () => {
      assert.match(refusal({ recipe: 'nip', runs: '0' }), /--runs/);
      assert.match(refusal({ recipe: 'nip', runs: '1.5' }), /--runs/);
    });

    it('--brewer with a model and an effort swaps that brewer', () => {
      assert.deepEqual(
        options({ recipe: 'nip', brewer: 'cellarman', model: 'claude-opus-5-5', effort: 'full' }),
        { kind: 'flight', ...swapped('claude-opus-5-5') },
      );
    });

    it('a model id on a recipe that names every level is refused: no level is free', () => {
      assert.match(
        refusal(
          { recipe: 'every-level', brewer: 'cellarman', model: 'claude-opus-5-5', effort: 'full' },
          withEveryLevel,
        ),
        /level/,
      );
    });

    it('a level on a recipe that names every level is taken: it borrows none', () => {
      assert.equal(
        options(
          { recipe: 'every-level', brewer: 'cellarman', model: 'strong', effort: 'full' },
          withEveryLevel,
        ).kind,
        'flight',
      );
    });
  });

  describe('its folder', () => {
    it('the recipe as it ships is named by the recipe alone', () => {
      assert.equal(flightFolderOf(SHIPPED), 'nip');
    });

    it('a swap names its brewer, model and effort, in a name Windows takes', () => {
      assert.equal(
        flightFolderOf(swapped('claude-opus-5-5[1m]')),
        'nip-cellarman-claude-opus-5-5_1m_-full',
      );
    });
  });

  describe("its Brewery's files", () => {
    it('the recipe as it ships gets no recipe copy and no models.jsonc, and the target its test line', () => {
      const files = flightBreweryFiles(SHIPPED, NIP, NAMES);
      assert.deepEqual(Object.keys(files), ['foedrum.jsonc']);
      const config = parseJsonc(files['foedrum.jsonc'] ?? '') as {
        repositories: Record<string, { checks: { test: string } }>;
      };
      assert.match(config.repositories[TARGET]?.checks.test ?? '', /^node --test/);
    });

    it('a dry run brews a copy of the recipe with test-first off and its steps as they ship', () => {
      const files = flightBreweryFiles({ ...SHIPPED, dryRun: true }, NIP, NAMES);
      const copy = copyOf(files, 'nip');
      assert.equal(Recipe.parse(parseJsonc(copy)).testFirst, false);
      assert.deepEqual(stepsOf(copy), stepsOf(NIP));
      assert.equal(files['models.jsonc'], undefined);
    });

    it("a swap on a level moves only the brewer's steps, with no models.jsonc", () => {
      const files = flightBreweryFiles(swapped('extreme'), NIP, NAMES);
      assert.equal(files['models.jsonc'], undefined);
      const steps = stepsOf(copyOf(files, 'nip'));
      const shipped = stepsOf(NIP);
      for (const [id, step] of steps) {
        const want =
          step.brewer === 'cellarman' ? { model: 'extreme', effort: 'full' } : shipped.get(id);
        assert.deepEqual(
          { model: step.model, effort: step.effort },
          {
            model: want?.model,
            effort: want?.effort,
          },
        );
      }
      assert.equal(steps.get('implement')?.model, 'extreme');
    });

    it('a model id on nip borrows strong, the first level nip leaves free', () => {
      const files = flightBreweryFiles(swapped('claude-opus-5-5'), NIP, NAMES);
      assert.equal(stepsOf(copyOf(files, 'nip')).get('implement')?.model, 'strong');
      assert.deepEqual(mappedLevels(files), { strong: 'claude-opus-5-5' });
    });

    it('a model id on deep-brew borrows extreme and leaves its taste step on strong', () => {
      const files = flightBreweryFiles(swapped('claude-sonnet-5-5', 'deep-brew'), DEEP, NAMES);
      const steps = stepsOf(copyOf(files, 'deep-brew'));
      assert.equal(steps.get('implement')?.model, 'extreme');
      assert.equal(steps.get('taste')?.model, 'strong');
      assert.deepEqual(mappedLevels(files), { extreme: 'claude-sonnet-5-5' });
    });

    it("a swapped Taster moves every child of nip's parallel group", () => {
      const files = flightBreweryFiles(swapped('light', 'nip', 'taster'), NIP, NAMES);
      const steps = stepsOf(copyOf(files, 'nip'));
      for (const id of ['correctness', 'acceptance', 'security', 'design-conformance']) {
        assert.deepEqual([steps.get(id)?.model, steps.get(id)?.effort], ['light', 'full'], id);
      }
      assert.equal(steps.get('implement')?.model, 'standard');
    });
  });

  describe('the model each step asks for', () => {
    it("the recipe as it ships asks each step for its level's family", () => {
      const asked = askedModels(SHIPPED, NIP);
      assert.equal(asked.get('map'), 'haiku');
      assert.equal(asked.get('implement'), 'sonnet');
      assert.equal(asked.get('security'), 'sonnet');
      assert.equal(asked.has('green'), false);
    });

    it("a swapped brewer's steps ask for the model id, the others for their own family", () => {
      const asked = askedModels(swapped('claude-opus-5-5'), NIP);
      assert.equal(asked.get('implement'), 'claude-opus-5-5');
      assert.equal(asked.get('gauge'), 'sonnet');
    });

    it("a swapped brewer on a level asks for that level's family", () => {
      assert.equal(askedModels(swapped('light'), NIP).get('implement'), 'haiku');
    });
  });

  describe("the dry run's scripted brewers", () => {
    it('Cellarman commits the whole solution, its tests and its code: a dry run skips the test-first steps', () => {
      const script = dryRunScript(ORDER, NIP);
      assert.deepEqual(Object.keys(script.implement?.[0]?.files ?? {}).sort(), [
        'src/posts.mjs',
        'test/posts.test.mjs',
      ]);
    });

    it('every Taster approves with no finding', () => {
      const script = dryRunScript(ORDER, NIP);
      for (const id of ['correctness', 'acceptance', 'security', 'design-conformance']) {
        assert.deepEqual(script[id]?.[0]?.tasting, { verdict: 'approve', findings: [] }, id);
      }
    });

    it('every brewer step of the recipe has a turn, and no check step', () => {
      assert.deepEqual(Object.keys(dryRunScript(ORDER, NIP)).sort(), [
        'acceptance',
        'correctness',
        'design-conformance',
        'fine',
        'gauge',
        'implement',
        'map',
        'security',
        'survey',
      ]);
    });
  });

  describe('the head a person gets', () => {
    it("the pull request's latest push is the head", () => {
      assert.deepEqual(
        headOf([
          started('green', 1, greenRead(GREEN_READ)),
          pushed(1, FIRST_PUSH),
          pushed(2, SECOND_PUSH),
        ]),
        { head: SECOND_PUSH, headFrom: 'pull request' },
      );
    });

    it('with no pull request, the commit the green step read last is the head', () => {
      assert.deepEqual(
        headOf([
          started('green', 1, greenRead(FIRST_PUSH)),
          started('green', 2, greenRead(GREEN_READ)),
        ]),
        { head: GREEN_READ, headFrom: 'green' },
      );
    });

    it('a batch with neither has no head', () => {
      assert.deepEqual(headOf([started('implement', 1, session('s'))]), {});
    });
  });

  describe('the changes outside the allowed paths', () => {
    it("a folder entry holds its files, never a sibling that starts with the folder's name", () => {
      assert.deepEqual(outsidePaths(['src/a.mjs', 'srcx/a.mjs', 'src'], ['src/']), [
        'srcx/a.mjs',
        'src',
      ]);
    });

    it('any other entry holds only that one file', () => {
      assert.deepEqual(outsidePaths(['README.md', 'README.md.bak', 'README.md/x'], ['README.md']), [
        'README.md.bak',
        'README.md/x',
      ]);
    });

    it("the Maltster's test map is never outside: it is Foedrum's file, not the order's", () => {
      assert.deepEqual(outsidePaths([TEST_MAP_PATH, 'package.json'], ['src/']), ['package.json']);
    });
  });

  it('the hidden tests passed on exit 0, failed on another code, and timed out with none', () => {
    assert.deepEqual([hiddenOf(0), hiddenOf(1), hiddenOf(null)], ['passed', 'failed', 'timed out']);
  });

  describe("a run's record", () => {
    const events = [
      started('implement', 1, session('impl')),
      finished('implement', 1, { usage: usage(10), receipt: { turns: 4, durationMs: 2_000 } }),
      started('correctness', 1, session('taste')),
      finished('correctness', 1, { usage: usage(5), receipt: { turns: 2, durationMs: 1_000 } }),
      started('green', 1, greenRead(GREEN_READ)),
      finished('green', 1),
      event({ type: 'batch.on_tap', batchId: '1-1', pullRequests: [] }),
    ];
    const asked = () => askedModels(SHIPPED, NIP);

    it('holds how the batch ended, its head, each step and the models each brewer step named', () => {
      const read = flightRecordOf(
        events,
        SHIPPED,
        asked(),
        transcripts({ impl: 'claude-sonnet-5-5', taste: 'claude-sonnet-5-6' }),
      );
      assert.equal(read.ended, 'on_tap');
      assert.equal(read.flight.head, GREEN_READ);
      assert.equal(read.flight.headFrom, 'green');
      assert.deepEqual(
        read.flight.steps.map(({ stepId, attempts, turns }) => [stepId, attempts, turns]),
        [
          ['implement', 1, 4],
          ['correctness', 1, 2],
          ['green', 1, 0],
        ],
      );
      assert.deepEqual(read.flight.models, {
        implement: ['claude-sonnet-5-5'],
        correctness: ['claude-sonnet-5-6'],
      });
      assert.equal(read.flight.unreadable, undefined);
    });

    it('says which transcript could not be found', () => {
      const read = flightRecordOf(
        events,
        SHIPPED,
        asked(),
        transcripts({ impl: 'claude-sonnet-5-5' }),
      );
      assert.match(read.flight.unreadable ?? '', /correctness 1/);
    });
  });

  describe('a run that measured nothing', () => {
    it('a run with no head measured nothing', () => {
      const { head: _, headFrom: __, ...flight } = record('post-slugs', 1).flight;
      assert.match(flightFailure({ ended: 'stuck: blocked', flight }) ?? '', /stuck: blocked/);
    });

    it('a run whose hidden tests failed measured the code all the same', () => {
      assert.equal(flightFailure(record('post-slugs', 1, { hidden: 'failed' })), undefined);
    });
  });

  describe('the model stop', () => {
    const asked = () => askedModels(swapped('claude-opus-5-5'), NIP);

    it('a swapped step on another model stops the Flight', () => {
      const stop = flightStop(
        record('post-slugs', 1, { models: { implement: ['claude-sonnet-5-5'] } }),
        asked(),
      );
      assert.match(stop ?? '', /implement.*claude-sonnet-5-5.*claude-opus-5-5/);
    });

    it("a step left as it ships stops the Flight on a model outside its level's family", () => {
      const stop = flightStop(
        record('post-slugs', 1, { models: { gauge: ['claude-haiku-5-5'] } }),
        asked(),
      );
      assert.match(stop ?? '', /gauge.*claude-haiku-5-5.*sonnet/);
    });

    it('a transcript that cannot say stops the Flight', () => {
      const stop = flightStop(
        record('post-slugs', 1, { unreadable: 'map 1: its transcript could not be found' }),
        asked(),
      );
      assert.match(stop ?? '', /map 1/);
    });

    it('a dated snapshot of the id asked for and the families asked for go on', () => {
      const models = { implement: ['claude-opus-5-5-20261101'], gauge: ['claude-sonnet-5-5'] };
      assert.equal(flightStop(record('post-slugs', 1, { models }), asked()), undefined);
    });
  });

  it('the next run goes order by order, run by run, and brews a run that measured nothing once more', () => {
    const { head: _, ...noHead } = record('b', 1).flight;
    const records = [record('b', 2), { ...record('b', 1), flight: noHead }, record('a', 1)];
    assert.deepEqual(nextFlightRun(records, 2, ['a', 'b']), { setup: 'a', run: 2, retry: false });
    const more = [...records, record('a', 2)];
    assert.deepEqual(nextFlightRun(more, 2, ['a', 'b']), { setup: 'b', run: 1, retry: true });
    assert.equal(
      nextFlightRun([...more, record('b', 1, {}, { retry: true })], 2, ['a', 'b']),
      undefined,
    );
  });

  it("the table shows each order's hidden tests passed, runs outside its paths, tokens and time", () => {
    const table = flightTable([
      record('quiz-rank', 1, { hidden: 'failed', outside: ['package.json'] }),
      record('post-slugs', 1),
      record('quiz-rank', 2),
      record('post-slugs', 2, { hidden: 'timed out' }),
    ]);
    const rows = table
      .split('\n')
      .filter((line) => line.startsWith('| post-slugs') || line.startsWith('| quiz-rank'));
    assert.deepEqual(rows, [
      '| quiz-rank | 2 | 1 of 2 | 1 | 38 | 40 s |',
      '| post-slugs | 2 | 1 of 2 | 0 | 38 | 40 s |',
    ]);
  });
});
