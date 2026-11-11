// The default plan lenses in `mash` and `deep-mash` (ADR 0321), from Foedrum's own defaults/: which
// lenses taste a plan side by side, on which model, and what their findings do, with serve's shell
// over an in-memory store, fake worktrees, a fake GitHub and scripted Tasters. No process starts
// (ADR 0021).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { modelOf } from '../../src/brewers/attempt-plan.ts';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { attemptBrewers } from '../../src/cli/attempt-brewers.ts';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { nextBatchId } from '../../src/engine/batch-id.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { emptyState } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { code, plain } from '../../src/engine/status-comment.ts';
import { recipeText } from '../helpers/brewery-files.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktreeMerge, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// Batch ids carry the time they were ordered (ADR 0380): those made at 2026-11-05T12:00:00Z.
const breweryIdOf = (issue: number): string =>
  nextBatchId(emptyState, issue, new Date('2026-11-05T12:00:00.000Z'));

const defaults = () => {
  const loaded = loadRecipes(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')));
  assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
  return loaded;
};

/** Each lens of a recipe's group: whether it blocks, where its findings go, and its model alias. */
const lensesOf = (recipeName: string) => {
  const loaded = defaults();
  const recipe = loaded.recipes.find(recipeName) ?? assert.fail(`no recipe ${recipeName}`);
  return (recipe.children('taste') ?? []).map((id) => {
    const step = loaded.brewers.find(recipeName, id);
    return {
      id,
      lens: step?.lens,
      blocking: step?.blocking,
      goto: recipe.routesTo(id, 'findings'),
      maxRounds: recipe.maxRounds(id, 'findings'),
      model: step?.brewer.model,
    };
  });
};

const blocks = (id: string, model: string) => ({
  id,
  lens: `plan/${id}`,
  blocking: true,
  goto: 'plan',
  maxRounds: 2,
  model,
});

describe('the default recipes that plan (ADR 0321)', () => {
  it("mash tastes its plan through coverage, sizing and naive reader side by side, every lens's findings sent back (ADR 0354)", () => {
    assert.deepStrictEqual(lensesOf('mash'), [
      blocks('coverage', 'planner'),
      blocks('sizing', 'builder'),
      blocks('naive-reader', 'builder'),
    ]);
    const mash = defaults().recipes.find('mash');
    assert.deepStrictEqual(mash?.steps, ['plan', 'coverage', 'sizing', 'naive-reader', 'lauter']);
    assert.equal(mash?.chosen('lauter'), 'lauter');
  });

  it('deep-mash tastes its plan through all seven plan lenses', () => {
    assert.deepStrictEqual(lensesOf('deep-mash'), [
      blocks('coverage', 'planner'),
      blocks('sizing', 'builder'),
      blocks('naive-reader', 'builder'),
      blocks('order-and-overlap', 'builder'),
      blocks('testability', 'builder'),
      blocks('recipe-fit', 'builder'),
      blocks('security', 'planner'),
    ]);
    const deepMash = defaults().recipes.find('deep-mash');
    assert.equal(deepMash?.firstStep, 'plan');
    assert.equal(deepMash?.chosen('lauter'), 'lauter');
  });

  it('each default plan lens loads under plan/ and names its question', () => {
    const questions: Record<string, string> = {
      coverage: 'builds what the order asks',
      sizing: 'about 1,000 lines or one mechanism',
      'naive-reader': 'as the brewer that builds it',
      'order-and-overlap': 'touch the same files',
      testability: 'a test or a run can show',
      'recipe-fit': 'the recipe each sub-order names',
      security: 'lets outside input reach something that acts on it',
    };
    const { lenses } = defaults().catalog;
    const plan = lenses.filter(({ name }) => name.startsWith('plan/'));
    assert.deepStrictEqual(
      plan.map(({ name }) => name).sort(),
      Object.keys(questions)
        .map((name) => `plan/${name}`)
        .sort(),
    );
    for (const { name, path, text } of plan) {
      const question = questions[name.slice('plan/'.length)] ?? assert.fail(name);
      assert.equal(path, `defaults/lenses/${name}.md`);
      const [heading, , opening] = text.split('\n');
      assert.match(heading ?? '', /^# Lens: /, name);
      assert.ok(opening?.includes(question), `${name} opens with: ${opening}`);
      assert.ok(opening?.includes('stay inside this one'), name);
      assert.match(text, /^## Do not$/m, name);
    }
  });

  it("the security plan lens adds a repository's own trust boundaries to its question and never limits it", () => {
    const lens = defaults().catalog.lenses.find(({ name }) => name === 'plan/security');
    const text = lens?.text ?? assert.fail('no plan/security');
    assert.match(text, /`\.foedrum\/trust-boundaries\.md`/);
    assert.match(text, /not listed there never means safe/i);
    // Foedrum's own page ships to no Brewery.
    assert.doesNotMatch(text, /docs\/trust-boundaries/);
  });

  it('gives a plan lens step the recipes a sub-order may name, and a diff lens step none', () => {
    const loaded = defaults();
    assert.deepStrictEqual(
      loaded.brewers.find('mash', 'sizing')?.choices?.map(({ name }) => name),
      ['deep-brew', 'nip'],
    );
    assert.equal(loaded.brewers.find('nip', 'correctness')?.choices, undefined);
  });

  it('gives a step of several plan lenses together the recipes too: regression test', () => {
    const files = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));
    const steps = [
      { id: 'plan', brewer: 'brewmaster' },
      {
        id: 'read',
        brewer: 'taster',
        lenses: ['plan/naive-reader', 'plan/sizing'],
        onFindings: { goto: 'plan', maxRounds: 1 },
      },
    ];
    const text = recipeText('kettle', steps, { testFirst: false });
    const loaded = loadRecipes({
      ...files,
      recipes: [{ path: 'recipes/kettle.jsonc', text }],
    });
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const names = loaded.brewers.find('kettle', 'read')?.choices?.map(({ name }) => name);
    assert.ok(names?.includes('nip'), JSON.stringify(names));
  });

  it('Nip and its diff lenses load as they did: regression test', () => {
    const loaded = defaults();
    assert.deepStrictEqual(loaded.recipes.find('nip')?.children('taste'), [
      'correctness',
      'acceptance',
      'security',
      'design-conformance',
    ]);
    const security = loaded.brewers.find('nip', 'security');
    assert.equal(security?.lens, 'diff/security');
    assert.equal(security?.lenses?.get('diff/security')?.path, 'defaults/lenses/diff/security.md');
    assert.equal(security?.brewer.model, 'builder');
    assert.equal(loaded.brewers.find('nip', 'correctness')?.blocking, true);
  });
});

/** A sub-order, as the Brewmaster's plan names it (ADR 0233). */
const subOrder = (id: string, recipe = 'nip') => ({
  id,
  title: `The ${id}`,
  repo: 'acme/web',
  size: { lines: 200, mechanism: `one ${id}` },
  doneWhen: `a test reads the ${id}`,
  touches: [{ path: `src/${id}.ts`, new: true }],
  recipe,
  why: 'small and test-first',
  ready: true,
});
const subOrders = [subOrder('schema'), subOrder('writer')];
const alternatives = {
  considered: [{ cut: 'one sub-order', whyNot: 'past a thousand lines' }],
  whyThis: 'each part merges alone',
};

describe('foedrum brew on recipe:mash and recipe:deep-mash, through the default plan lenses', () => {
  let dir: TempDir;
  let setup: ServeSetup;
  let store: EventStore;
  let lines: string[];
  let api: FakeGitHubApi;
  /** `<step>#<attempt>` of each attempt, in the order it started. */
  let started: string[];
  /** By `<step>#<attempt>`: the prompt and the model each attempt was planned with. */
  let prompts: Map<string, string>;
  let models: Map<string, string>;

  const issue = (recipe: string) => ({
    number: 12,
    labels: [`recipe:${recipe}`],
    author: 'ann',
    title: 'Export the batches',
    body: 'Add an export of the batches, with a guide.',
  });

  beforeEach(() => {
    dir = makeTempDir('mash-lenses');
    const files = serveInputs().files;
    const brewery = readBreweryFiles(dir.path);
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          local: local({ workRoot: dir.path }),
          brewery: {
            ...files.brewery,
            ...(brewery.defaults === undefined ? {} : { defaults: brewery.defaults }),
          },
        },
      }),
    );
    setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    store = { ...openSqliteEventStore(':memory:'), close: () => {} };
    lines = [];
    started = [];
    prompts = new Map();
    models = new Map();
    api = fakeGitHubApi({
      login: 'ann',
      issues: { 'acme/brewery': [issue('mash')] },
    });
  });
  afterEach(() => dir.remove());

  const log = () => createCommandLog({ store, recipes: setup.recipes });
  const request: BrewRequest = { target: { issue: 12 }, owner: 'ann', by: 'ann', via: 'terminal' };

  /** serve's shell whose runner plans each attempt and plays its step's script. */
  const shell = (script: Readonly<Record<string, readonly Behaviour[]>>): ServeShell => {
    let ticks = 0;
    const runnerOf = (plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>): BrewerRunner => {
      const inner = fakeBrewerRunner(script);
      return {
        start: (start) => {
          const key = `${start.ref.stepId}#${start.ref.attempt}`;
          started.push(key);
          const ended = plan(start).then(async (made) => {
            prompts.set(key, made.prompt);
            models.set(key, made.call.model);
            const end = await inner.start(start).ended;
            // The out doc stays in its worktree, which the route and a later round read (ADR 0128).
            if (end.outDoc !== undefined) {
              mkdirSync(made.cwd, { recursive: true });
              writeFileSync(join(made.cwd, start.limits.outDoc.file), end.outDoc);
            }
            return end;
          });
          return { ended, stop: () => {} };
        },
        progress: inner.progress,
      };
    };
    return {
      out: (line) => lines.push(line),
      signal: new AbortController().signal,
      clock: () => new Date('2026-11-05T12:00:00.000Z'),
      wait: async () => {
        ticks++;
        if (ticks > 40) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
      },
      lock: () => fakeLock('ann'),
      openStore: () => store,
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => ({ kind: 'unchanged' }),
      }),
      worktrees: async () => fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') }),
      merge: () => fakeWorktreeMerge(),
      push: () => ({
        commit: async () => FAKE_COMMIT,
        baseTip: async () => 'b'.repeat(40),
        isAncestor: async (commit, of) => commit === of,
        remoteTip: async () => undefined,
        push: async () => {},
        secretScan: async () => [],
        touchedFiles: async () => [],
      }),
      runner: (_claude, plan) => runnerOf(plan),
      exec: () => Promise.reject(new Error('no check step runs here')),
      setup: () => Promise.reject(new Error('no repository setup runs here')),
      gh: ghOver(api.fetch).exec,
      // The Taster's house yeast is read at the commit it reviews (ADR 0169): the clone has none.
      git: (_cwd, args) =>
        args[0] === 'ls-tree'
          ? Promise.resolve({ code: 0, stdout: '', stderr: '' })
          : Promise.reject(new Error(`no git ${args[0]} runs here`)),
    };
  };

  const planned = behave.succeedWith({ subOrders, alternatives }, 'Planned');
  const approves = behave.succeedWith({ verdict: 'approve', findings: [] }, 'Nothing here');
  const guide = {
    severity: 'major',
    why: 'writer: the guide the order asks for is built by no sub-order',
    introduced: true,
  };
  const big = {
    severity: 'major',
    why: 'schema: its entry holds two mechanisms',
    introduced: true,
  };
  const asksChanges = (finding: Record<string, unknown>): Behaviour =>
    behave.succeedWith({ verdict: 'changes', findings: [finding] }, 'Changes asked for');
  const replanned = (why?: string): Behaviour =>
    behave.succeedWith(
      {
        subOrders,
        alternatives,
        dispositions: [
          why === undefined ? { disposition: 'fixed' } : { disposition: 'dismissed', why },
        ],
      },
      'Planned again',
    );
  const stuckReason = () => {
    const { lane } =
      log().state().batches.get(breweryIdOf(12)) ?? assert.fail(`no batch ${breweryIdOf(12)}`);
    return lane.kind === 'stuck' ? lane.reason : assert.fail(lane.kind);
  };
  const review = (): string => {
    const shown =
      (api.comments.get('acme/brewery#12') ?? []).find(({ body }) => body.includes('plan of batch'))
        ?.body ?? assert.fail('no plan comment');
    return shown.slice(shown.indexOf('**Review**'), shown.indexOf('**Gate**')).trim();
  };

  it('a plan lens step runs on the model its step names', async () => {
    const script = {
      plan: [planned],
      coverage: [approves],
      sizing: [approves],
      'naive-reader': [approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.equal(models.get('coverage#1'), 'opus');
    assert.equal(models.get('sizing#1'), 'sonnet');
    assert.equal(models.get('naive-reader#1'), 'sonnet');
  });

  it('a usage window holds a plan lens step by the family of the model its step names', async () => {
    const script = {
      plan: [planned],
      coverage: [approves],
      sizing: [approves],
      'naive-reader': [approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    const brewers = attemptBrewers({
      state: () => log().state(),
      brewers: setup.brewers,
      models: setup.models,
    });
    const family = (stepId: string) =>
      brewers.family({ batchId: breweryIdOf(12), stepId, attempt: 1 });
    assert.equal(family('coverage'), 'Opus');
    assert.equal(family('sizing'), 'Sonnet');
  });

  it('a blind-tasting swap of the Taster moves a step that names its own model', () => {
    const coverage = setup.brewers.find('mash', 'coverage')?.brewer ?? assert.fail('no coverage');
    const swapped = { ...setup.models, brewers: { taster: 'builder' } };
    assert.equal(modelOf(setup.models, coverage), 'opus');
    assert.equal(modelOf(swapped, coverage), 'sonnet');
  });

  it("gives each plan lens's Taster the recipes a sub-order may name", async () => {
    const script = {
      plan: [planned],
      coverage: [approves],
      sizing: [approves],
      'naive-reader': [approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    const recipes = (key: string) =>
      /source="[^"]*" name="recipes">\n([^<]*)</.exec(prompts.get(key) ?? '')?.[1] ?? '';
    for (const key of ['coverage#1', 'sizing#1', 'naive-reader#1']) {
      assert.match(recipes(key), /^- nip \(brew\): /m, key);
      assert.doesNotMatch(recipes(key), /^- deep-mash /m, key);
    }
  });

  it('a plan lens in mash sends the plan back to the Brewmaster once, and the Review lists the dismissal', async () => {
    const evidence = 'The order says "with a guide", and subOrders[1].touches holds it';
    const corrected = behave.succeedWith(
      {
        subOrders: [subOrder('schema'), subOrder('guide')],
        alternatives,
        dispositions: [{ disposition: 'dismissed', why: evidence }],
      },
      'Planned again',
    );
    const script = {
      plan: [planned, corrected],
      coverage: [asksChanges(guide), approves],
      sizing: [approves, approves],
      'naive-reader': [approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    // Only coverage, whose findings sent the plan back, reads the corrected plan (ADR 0357).
    assert.deepStrictEqual([...started].sort(), [
      'coverage#1',
      'coverage#2',
      'naive-reader#1',
      'plan#1',
      'plan#2',
      'sizing#1',
    ]);
    assert.equal(started[0], 'plan#1');
    assert.ok(started.indexOf('plan#2') < started.indexOf('coverage#2'), started.join(' '));
    assert.ok(prompts.get('coverage#2')?.includes('The guide'), 'coverage#2 reads the new plan');
    assert.ok(!prompts.get('coverage#1')?.includes('The guide'), 'coverage#1 reads the first');
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 2 });
    assert.equal(
      review(),
      [
        '**Review**',
        '',
        `- ${code('coverage')} #1: major, dismissed: ${plain(guide.why)}`,
        `  - why: ${plain(evidence)}`,
      ].join('\n'),
    );
  });

  it('when coverage and sizing both block, the plan goes back for coverage first and sizing next', async () => {
    const script = {
      plan: [planned, replanned(), replanned()],
      coverage: [asksChanges(guide), approves, approves],
      sizing: [asksChanges(big), asksChanges(big), approves],
      'naive-reader': [approves, approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    const attempts = log().state().batches.get(breweryIdOf(12))?.steps.get('plan')?.attempts;
    assert.equal(attempts?.get(2)?.route?.from, 'coverage');
    assert.equal(attempts?.get(3)?.route?.from, 'sizing');
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 3 });
    // Sizing's findings wait a round: the first route carries only coverage's.
    const route = (key: string) => /name="route">([^<]*)</.exec(prompts.get(key) ?? '')?.[1] ?? '';
    assert.ok(route('plan#2').includes(JSON.stringify(guide.why)), route('plan#2'));
    assert.ok(!route('plan#2').includes(JSON.stringify(big.why)), route('plan#2'));
    assert.ok(route('plan#3').includes(JSON.stringify(big.why)), route('plan#3'));
  });

  it("coverage and sizing share the group's two rounds: three plans at most (ADR 0354)", async () => {
    const script = {
      plan: [planned, replanned(), replanned()],
      coverage: [asksChanges(guide), approves],
      sizing: [asksChanges(big), asksChanges(big), asksChanges(big)],
      'naive-reader': [approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    // Coverage's round, then sizing's alone: sizing asks again on the third plan, and the group's
    // route has no round left.
    assert.ok(started.includes('plan#3'), started.join(' '));
    assert.ok(!started.includes('plan#4'), started.join(' '));
    assert.equal(stuckReason().kind, 'blocked');
    assert.ok(
      review().includes(`- ${code('sizing')} #3: major, open: ${plain(big.why)}`),
      review(),
    );
  });

  it("a plan lens step's later round gets a retry of its own after a failed attempt", async () => {
    const script = {
      plan: [planned, replanned()],
      coverage: [asksChanges(guide), approves],
      // Findings in round 1, so sizing runs again in round 2 (ADR 0357).
      sizing: [asksChanges(big), behave.fail(true), approves],
      'naive-reader': [approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.ok(started.includes('sizing#3'), started.join(' '));
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 2 });
  });

  it('a blocking plan lens that asked for changes gets a retry of its own in the next round', async () => {
    const script = {
      plan: [planned, replanned()],
      coverage: [asksChanges(guide), behave.fail(true), approves],
      sizing: [approves, approves],
      'naive-reader': [approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.ok(started.includes('coverage#3'), started.join(' '));
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 2 });
  });

  it("a plan lens step's later round still ends after its brewer's attempts", async () => {
    const script = {
      plan: [planned, replanned()],
      coverage: [asksChanges(guide), approves],
      // Findings in round 1, so sizing runs again in round 2 (ADR 0357).
      sizing: [asksChanges(big), behave.fail(true), behave.fail(true)],
      'naive-reader': [approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.ok(started.includes('sizing#3'), started.join(' '));
    assert.ok(!started.includes('sizing#4'), started.join(' '));
    assert.equal(stuckReason().kind, 'attempts_exhausted');
  });

  it('a blocking plan lens that runs out of its rounds leaves the batch Stuck with its finding open: regression test', async () => {
    const script = {
      plan: [planned, replanned(), replanned()],
      coverage: [asksChanges(guide), asksChanges(guide), asksChanges(guide)],
      sizing: [approves, approves, approves],
      'naive-reader': [approves, approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.ok(started.includes('coverage#3'), started.join(' '));
    assert.ok(!started.includes('plan#4'), started.join(' '));
    assert.equal(stuckReason().kind, 'blocked');
    assert.ok(
      review().includes(`- ${code('coverage')} #3: major, open: ${plain(guide.why)}`),
      review(),
    );
  });

  it("a plan whose findings outlast the rounds is Stuck, and a person's skip brings it to its review (ADR 0354): regression test", async () => {
    const script = {
      plan: [planned, replanned(), replanned()],
      coverage: [asksChanges(guide), asksChanges(guide), asksChanges(guide)],
      sizing: [approves, approves, approves],
      'naive-reader': [approves, approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.equal(stuckReason().kind, 'blocked');
    const at = new Date('2026-11-08T12:00:00.000Z');
    const skipped = log().issue(
      { kind: 'skip', batchId: breweryIdOf(12), by: 'ann', via: 'terminal' },
      at,
    );
    assert.equal(skipped.kind, 'accepted', JSON.stringify(skipped));
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 3 });
  });

  it("a person's lauter on the default mash opens its session and tastes nothing again: regression test", async () => {
    const script = {
      plan: [planned],
      coverage: [approves],
      sizing: [approves],
      'naive-reader': [approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    const before = started.length;
    const corrected = behave.succeedWith({ subOrders, alternatives }, 'Corrected');
    const lauter: BrewRequest = { ...request, lauter: breweryIdOf(12) };
    assert.equal(await runBrew(setup, shell({ lauter: [corrected] }), lauter), 3, lines.join('\n'));
    assert.deepStrictEqual(started.slice(before), ['lauter#1']);
    assert.ok(
      lines.includes('foedrum lauter: #12 goes to a session on its plan'),
      lines.join('\n'),
    );
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'lauter', attempt: 1 });
  });

  it("a person's retry at the review of the default mash plans again and tastes the new plan: regression test", async () => {
    const script = {
      plan: [planned, planned],
      coverage: [approves, approves],
      sizing: [approves, approves],
      'naive-reader': [approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    const at = new Date('2026-11-05T12:00:00.000Z');
    const retried = log().issue(
      { kind: 'retry', batchId: breweryIdOf(12), by: 'ann', via: 'terminal' },
      at,
    );
    assert.equal(retried.kind, 'accepted', JSON.stringify(retried));
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.deepStrictEqual(started.slice(4).sort(), [
      'coverage#2',
      'naive-reader#2',
      'plan#2',
      'sizing#2',
    ]);
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 2 });
  });

  it("after a person's retry, a lens that used both its rounds and blocks the new plan leaves the batch Stuck: regression test", async () => {
    const script = {
      plan: [planned, replanned(), replanned(), planned],
      coverage: [asksChanges(guide), asksChanges(guide), approves, asksChanges(guide)],
      sizing: [approves, approves, approves, approves],
      'naive-reader': [approves, approves, approves, approves],
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 3 });
    const at = new Date('2026-11-05T12:00:00.000Z');
    const retried = log().issue(
      { kind: 'retry', batchId: breweryIdOf(12), by: 'ann', via: 'terminal' },
      at,
    );
    assert.equal(retried.kind, 'accepted', JSON.stringify(retried));
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.ok(started.includes('coverage#4'), started.join(' '));
    assert.ok(!started.includes('plan#5'), started.join(' '));
    assert.equal(stuckReason().kind, 'blocked');
  });

  it('deep-mash runs its seven lenses after the plan, and the plan waits for its review', async () => {
    api = fakeGitHubApi({ login: 'ann', issues: { 'acme/brewery': [issue('deep-mash')] } });
    const lenses = [
      'coverage',
      'sizing',
      'naive-reader',
      'order-and-overlap',
      'testability',
      'recipe-fit',
      'security',
    ];
    const script = {
      plan: [planned],
      ...Object.fromEntries(lenses.map((lens) => [lens, [approves]])),
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.deepStrictEqual(
      [...started].sort(),
      ['plan', ...lenses].map((step) => `${step}#1`).sort(),
    );
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 1 });
  });

  it("a recipe's guidance reaches recipe-fit's recipes input", async () => {
    api = fakeGitHubApi({ login: 'ann', issues: { 'acme/brewery': [issue('deep-mash')] } });
    const lenses = [
      'coverage',
      'sizing',
      'naive-reader',
      'order-and-overlap',
      'testability',
      'recipe-fit',
      'security',
    ];
    const script = {
      plan: [planned],
      ...Object.fromEntries(lenses.map((lens) => [lens, [approves]])),
    };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    const recipes =
      /source="[^"]*" name="recipes">\n([^<]*)</.exec(prompts.get('recipe-fit#1') ?? '')?.[1] ?? '';
    const offered = defaults().brewers.find('deep-mash', 'recipe-fit')?.choices ?? [];
    assert.deepEqual(
      offered.map(({ name }) => name),
      ['deep-brew', 'nip'],
    );
    for (const { name, guidance } of offered) {
      assert.ok(guidance !== undefined, `${name} has no guidance`);
      assert.ok(
        recipes.includes(
          `  Choose when: ${guidance.chooseWhen}\n  Not when: ${guidance.notWhen}\n  Best used: ${guidance.bestUsed}\n`,
        ),
        recipes,
      );
    }
  });

  it('a Brewery recipe of plan then a single plan/naive-reader still runs: regression test', async () => {
    const files = serveInputs().files;
    const brewery = readBreweryFiles(dir.path);
    const steps = [
      { id: 'plan', brewer: 'brewmaster' },
      {
        id: 'naive',
        brewer: 'taster',
        lens: 'plan/naive-reader',
        onFindings: { goto: 'plan', maxRounds: 1 },
      },
    ];
    const kettle = recipeText('kettle', steps, { testFirst: false });
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          local: local({ workRoot: dir.path }),
          brewery: {
            ...files.brewery,
            recipes: [...files.brewery.recipes, { path: 'recipes/kettle.jsonc', text: kettle }],
            ...(brewery.defaults === undefined ? {} : { defaults: brewery.defaults }),
          },
        },
      }),
    );
    setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    api = fakeGitHubApi({ login: 'ann', issues: { 'acme/brewery': [issue('kettle')] } });
    const script = { plan: [planned], naive: [approves] };
    assert.equal(await runBrew(setup, shell(script), request), 3, lines.join('\n'));
    assert.deepStrictEqual(started, ['plan#1', 'naive#1']);
    assert.equal(models.get('naive#1'), 'sonnet');
    assert.deepStrictEqual(stuckReason(), { kind: 'plan_review', stepId: 'plan', attempt: 1 });
  });

  it("refuses a parallel group's child whose model alias models.jsonc has no model for: regression test", () => {
    const files = serveInputs().files;
    const text = recipeText(
      'kettle',
      [
        { id: 'plan', brewer: 'brewmaster' },
        {
          id: 'taste',
          parallel: [
            { id: 'naive', brewer: 'taster', lens: 'plan/naive-reader', model: 'nowhere' },
          ],
          onFindings: { goto: 'plan', maxRounds: 1 },
        },
      ],
      { testFirst: false },
    );
    const brewery = readBreweryFiles(dir.path);
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          brewery: {
            ...files.brewery,
            recipes: [...files.brewery.recipes, { path: 'recipes/kettle.jsonc', text }],
            ...(brewery.defaults === undefined ? {} : { defaults: brewery.defaults }),
          },
        },
      }),
    );
    assert.ok(result.kind === 'refused', result.kind);
    assert.ok(
      result.problems.includes(
        'recipes/kettle.jsonc: step "naive" names the model alias "nowhere", which models.jsonc has no model for',
      ),
      result.problems.join('\n'),
    );
  });

  it("refuses a recipe's step whose model alias models.jsonc has no model for", () => {
    const files = serveInputs().files;
    const text = recipeText(
      'kettle',
      [{ id: 'plan', brewer: 'cellarman', model: 'nowhere' }, { action: 'openPullRequest' }],
      { testFirst: false },
    );
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          brewery: {
            ...files.brewery,
            recipes: [...files.brewery.recipes, { path: 'recipes/kettle.jsonc', text }],
          },
        },
      }),
    );
    assert.ok(result.kind === 'refused', result.kind);
    assert.ok(
      result.problems.includes(
        'recipes/kettle.jsonc: step "plan" names the model alias "nowhere", which models.jsonc has no model for',
      ),
      result.problems.join('\n'),
    );
  });
});
