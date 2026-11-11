// `foedrum mash` through runBrew (ADR 0232): it brews an order's planning steps as a driver of its
// own. serve's shell with an in-memory store, fake worktrees, a fake GitHub and the scripted runner;
// no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { nextBatchId, targetBatchId } from '../../src/engine/batch-id.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStoreTransaction as Transaction } from '../../src/engine/event-store.ts';
import { emptyState } from '../../src/engine/fold.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';

/** The id the mash orders issue's batch under, on the fixture's clock (ADR 0380). */
const breweryIdOf = (issue: number): string => nextBatchId(emptyState, issue, t0);

describe('runBrew', () => {
  const f = brewFixture();
  const { log, shell } = f;

  describe('foedrum mash (ADR 0232)', () => {
    // A second recipe like stout, so the Innkeeper has two to offer beside porter and nip.
    const mild = JSON.stringify({ ...JSON.parse(recipe), name: 'mild', description: 'A mild.' });
    /**
     * The test Brewery with Foedrum's defaults under it, mash-in and the Innkeeper among them; with
     * `only`, the Brewery's recipes are that one, and Foedrum's are mash-in alone.
     */
    const mashSetup = (
      fields: { config?: string; only?: string; keep?: string } = {},
    ): ServeSetup => {
      // With `only`, the one default recipe kept: mash-in, unless `keep` names another.
      const kept = `/${fields.keep ?? 'mash-in'}.jsonc`;
      const inputs = serveInputs();
      const { defaults = {} } = readBreweryFiles(join(f.dir.path, 'no-brewery'));
      const own = [
        ...(inputs.files.brewery.recipes ?? []),
        { path: 'recipes/mild.jsonc', text: mild },
      ];
      const result = serveSetup(
        serveInputs({
          files: {
            ...inputs.files,
            ...(fields.config === undefined ? {} : { config: fields.config }),
            local: local({ workRoot: f.dir.path }),
            brewery: {
              ...inputs.files.brewery,
              recipes:
                fields.only === undefined
                  ? own
                  : own.filter(({ path }) => path === `recipes/${fields.only}.jsonc`),
              defaults:
                fields.only === undefined
                  ? defaults
                  : {
                      ...defaults,
                      recipes: (defaults.recipes ?? []).filter(({ path }) => path.endsWith(kept)),
                    },
            },
          },
        }),
      );
      return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    };
    const which = (issue: number): Question => ({
      q: `Which recipe brews #${issue}? Suggested: mild: one small change`,
      options: ['stout', 'mild'],
      recommended: 'mild',
      whyBlocking: 'The recipe decides what runs next',
    });
    const mash = (issue: number): BrewRequest => ({ ...request, target: { issue }, mash: true });

    it('orders and routes an issue with no batch to mash-in, and stops with its question: exit 4', async () => {
      const asks = shell(behave.needInput([which(13)]));
      assert.equal(await runBrew(mashSetup(), asks, mash(13)), 4, f.lines.join('\n'));
      assert.deepStrictEqual(f.started, ['innkeep#1']);
      assert.deepStrictEqual(log().state().batches.get(breweryIdOf(13))?.recipe, {
        name: 'mash-in',
        type: 'mash',
        reason: 'the engineer ran foedrum mash',
        source: 'human',
        by: 'ann',
        via: 'terminal',
      });
      assert.ok(f.lines.includes('foedrum mash: ordered #13'), f.lines.join('\n'));
      assert.deepStrictEqual(f.lines.slice(-4), [
        'foedrum mash: #13 needs input at innkeep:',
        'foedrum mash:   1. Which recipe brews #13? Suggested: mild: one small change (stout, mild; recommended: mild)',
        'foedrum mash:      why it blocks: The recipe decides what runs next',
        'foedrum mash: answer them in order with foedrum answer 13 <answer 1>, then brew again',
      ]);
    });

    for (const choice of ['stout', 'mild']) {
      it(`labels the issue recipe:${choice} once when the answer is ${choice}, and brews it from its first step`, async () => {
        const brewing = mashSetup();
        assert.equal(await runBrew(brewing, shell(behave.needInput([which(13)])), mash(13)), 4);
        const answered = createCommandLog({ store: f.store, recipes: brewing.recipes }).issue(
          {
            kind: 'answer',
            batchId: breweryIdOf(13),
            by: 'ann',
            via: 'terminal',
            answers: [{ q: which(13).q, answer: choice }],
          },
          t0,
        );
        assert.equal(answered.kind, 'accepted', JSON.stringify(answered));
        const brew = { ...request, target: { issue: 13 } };
        // The next process of the same owner takes the lock again.
        const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
        assert.equal(await runBrew(brewing, again, brew), 0, f.lines.join('\n'));
        assert.deepStrictEqual(f.started, ['innkeep#1', 'brew#1']);
        assert.equal(log().state().batches.get(breweryIdOf(13))?.recipe?.name, choice);
        const labels = f.api.issue('acme/brewery', 13)?.labels ?? [];
        assert.deepStrictEqual(
          labels.filter((label) => label.startsWith('recipe:')),
          [`recipe:${choice}`],
        );
      });
    }

    for (const [issue, stuck] of [
      [13, false],
      [12, true],
    ] as const) {
      it(`routes ${stuck ? 'a batch Stuck on routing' : 'an Ordered batch'}, ordering it not again: exit 4`, async () => {
        const id = breweryIdOf(issue);
        log().issue({ kind: 'order', batchId: id, order: { issue } }, t0);
        // Past its routing deadline (ADR 0032).
        const late = new Date(t0.getTime() + 24 * 3_600_000);
        if (stuck) log().issue({ kind: 'unrouted', batchId: id }, late);
        assert.equal(log().state().batches.get(id)?.lane.kind, stuck ? 'stuck' : 'ordered');
        const asks = shell(behave.needInput([which(issue)]));
        assert.equal(await runBrew(mashSetup(), asks, mash(issue)), 4, f.lines.join('\n'));
        assert.equal(log().state().batches.get(id)?.recipe?.name, 'mash-in');
        assert.ok(!f.lines.some((line) => line.includes(`ordered #${issue}`)), f.lines.join('\n'));
      });
    }

    it("links a plan's out doc on the Brewery's own GitHub host: regression test (#659)", async () => {
      const subOrder = {
        id: 'one',
        title: 'One',
        repo: 'acme/web',
        size: { lines: 10, mechanism: 'a flag' },
        doneWhen: 'a test passes',
        touches: [{ path: 'src' }],
        recipe: 'stout',
        why: 'small',
        ready: true,
      };
      const brewing = { ...mashSetup(), github: { hostname: 'github.localhost' } };
      const mashLog = createCommandLog({ store: f.store, recipes: brewing.recipes });
      mashLog.issue({ kind: 'order', batchId: breweryIdOf(13), order: { issue: 13 } }, t0);
      mashLog.issue(
        {
          kind: 'route',
          batchId: breweryIdOf(13),
          recipe: 'mash',
          reason: 'label',
          source: 'label',
        },
        t0,
      );
      const plans = behave.succeedWith({ assumptions: ['Kept the flag'], subOrders: [subOrder] });
      await runBrew(brewing, shell(plans), { ...request, target: { issue: 13 } });
      const bodies = (f.api.comments.get('acme/brewery#13') ?? []).map(({ body }) => body);
      const link = `[${breweryIdOf(13)}/plan-1.md](<https://github.localhost/${f.setup.brewery}/blob/foedrum/state/batches/${breweryIdOf(13)}/plan-1.md>)`;
      assert.ok(
        bodies.some((body) => body.includes(`Full plan: ${link}`)),
        bodies.join('\n---\n'),
      );
    });

    it("links a plan's out doc on the Brewery's state branch from its comments (#659)", async () => {
      const subOrder = {
        id: 'one',
        title: 'One',
        repo: 'acme/web',
        size: { lines: 10, mechanism: 'a flag' },
        doneWhen: 'a test passes',
        touches: [{ path: 'src' }],
        recipe: 'stout',
        why: 'small',
        ready: true,
      };
      const brewing = mashSetup();
      const mashLog = createCommandLog({ store: f.store, recipes: brewing.recipes });
      for (const command of [
        { kind: 'order', batchId: breweryIdOf(13), order: { issue: 13 } },
        {
          kind: 'route',
          batchId: breweryIdOf(13),
          recipe: 'mash',
          reason: 'label',
          source: 'label',
        },
      ] as const) {
        const decision = mashLog.issue(command, t0);
        assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      }
      const plans = behave.succeedWith({ assumptions: ['Kept the flag'], subOrders: [subOrder] });
      await runBrew(brewing, shell(plans), { ...request, target: { issue: 13 } });
      const link = `[${breweryIdOf(13)}/plan-1.md](<https://github.com/${f.setup.brewery}/blob/foedrum/state/batches/${breweryIdOf(13)}/plan-1.md>)`;
      const bodies = (f.api.comments.get('acme/brewery#13') ?? []).map(({ body }) => body);
      const shown = bodies.join('\n---\n');
      assert.ok(
        bodies.some((body) => body.includes(`- \`plan\`: full plan: ${link}`)),
        shown,
      );
      assert.ok(
        bodies.some((body) => body.includes(`Full plan: ${link}`)),
        shown,
      );
    });

    it("links a claimed order's plan comment on its Brewery issue and the Brewery's own host: regression test (#658)", async () => {
      const web = { alias: 'web', intake: { labels: ['foedrum'] } };
      f.api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: [], author: 'ann', title: 'Export', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Export', body: 'Export.' },
          ],
        },
      });
      const claimed = {
        ...mashSetup({ config: config({}, web) }),
        github: { hostname: 'github.localhost' },
      };
      const claimedLog = createCommandLog({ store: f.store, recipes: claimed.recipes });
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      for (const command of [
        { kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } },
        { kind: 'record', event: { type: 'effect.applied', key, result: 40 } },
        { kind: 'route', batchId: 'web-7', recipe: 'mash', reason: 'label', source: 'label' },
      ] as const) {
        const decision = claimedLog.issue(command, t0);
        assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      }
      const subOrder = {
        id: 'one',
        title: 'One',
        repo: 'acme/web',
        size: { lines: 10, mechanism: 'a flag' },
        doneWhen: 'a test passes',
        touches: [{ path: 'src' }],
        recipe: 'stout',
        why: 'small',
        ready: true,
      };
      const plans = behave.succeedWith({ assumptions: ['Kept the flag.'], subOrders: [subOrder] });
      const target = { ...request, target: { issue: 40 } };
      // The default mash's Tasters approve the plan (ADR 0321).
      const approves = behave.succeedWith({ verdict: 'approve', findings: [] });
      const runner = () =>
        fakeBrewerRunner(({ ref }) => (ref.stepId === 'plan' ? plans : approves));
      assert.equal(await runBrew(claimed, shell(plans, { runner }), target), 3, f.lines.join('\n'));
      const bodies = (f.api.comments.get('acme/brewery#40') ?? []).map(({ body }) => body);
      const plan = (f.api.comments.get('acme/brewery#40') ?? []).find(({ body }) =>
        body.includes('plan of batch'),
      );
      const url = `https://github.localhost/${claimed.brewery}/issues/40#issuecomment-${plan?.id}`;
      assert.ok(
        bodies.some((body) => body.includes(`is ready for your review: [plan comment](<${url}>)`)),
        bodies.join('\n---\n'),
      );
      // Its commands use the Brewery issue's number, never the target issue's or the batch's.
      assert.ok(plan?.body.includes('Waiting for `foedrum approve 40`.'), plan?.body);
      assert.ok(plan?.body.includes('or end it with `foedrum cancel 40`.'), plan?.body);
    });

    it('routes a claimed order through its Brewery issue: exit 4', async () => {
      const web = { alias: 'web', intake: { labels: ['foedrum'] } };
      f.api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: [], author: 'ann', title: 'Dark theme', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark theme', body: 'Dark.' },
          ],
        },
      });
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = mashSetup({ config: config({}, web) });
      const asks = shell(behave.needInput([which(40)]));
      assert.equal(await runBrew(claimed, asks, mash(40)), 4, f.lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe?.name, 'mash-in');
      assert.deepStrictEqual([...log().state().batches.keys()], ['web-7']);
    });

    it('mashes a claimed issue with no batch: claims it, orders it and routes it to mash-in, exit 4 (ADR 0232)', async () => {
      const web = { alias: 'web', intake: { labels: ['foedrum'] } };
      f.api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark theme', body: 'Dark.' },
          ],
        },
      });
      const claimed = mashSetup({ config: config({}, web) });
      const asks = shell(behave.needInput([which(7)]));
      const fresh = { ...request, target: { alias: 'web', issue: 7 }, mash: true } as const;
      assert.equal(await runBrew(claimed, asks, fresh), 4, f.lines.join('\n'));
      assert.equal(
        log()
          .state()
          .batches.get(targetBatchId(emptyState, 'web', 7, t0))?.recipe?.name,
        'mash-in',
      );
      assert.ok(f.lines.includes('foedrum mash: ordered web#7'), f.lines.join('\n'));
    });

    it('refuses a batch that started a recipe, naming foedrum recipe: exit 5', async () => {
      log().issue({ kind: 'order', batchId: breweryIdOf(12), order: { issue: 12 } }, t0);
      const route = {
        kind: 'route',
        batchId: breweryIdOf(12),
        recipe: 'stout',
        reason: 'label',
      } as const;
      log().issue({ ...route, source: 'label' }, t0);
      assert.equal(await runBrew(mashSetup(), shell(behave.succeed()), mash(12)), 5);
      assert.deepStrictEqual(f.started, []);
      assert.equal(
        f.lines.at(-1),
        'foedrum mash: #12 already brews the recipe stout; foedrum mash 12 --override asks the Innkeeper again, or foedrum recipe 12 <recipe> <reason> brews it with another',
      );
    });

    it('refuses a Brewery with one recipe to offer, ordering nothing: exit 5', async () => {
      const one = mashSetup({ only: 'stout' });
      assert.equal(await runBrew(one, shell(behave.succeed()), mash(13)), 5, f.lines.join('\n'));
      assert.equal(log().state().batches.size, 0);
      assert.equal(
        f.lines.at(-1),
        'foedrum mash: the Brewery has one recipe to offer, stout: label #13 recipe:stout to brew it',
      );
    });

    const refusals: [string, Parameters<typeof mashSetup>[0], string][] = [
      ['without mash-in', { only: 'stout', keep: 'nip' }, 'the Brewery has no recipe mash-in'],
      [
        'with no recipe to offer',
        { only: 'none' },
        'the Brewery has no recipe to offer but mash-in',
      ],
    ];
    for (const [what, fields, line] of refusals) {
      it(`refuses a Brewery ${what}, ordering nothing: exit 5`, async () => {
        const refusing = mashSetup(fields);
        assert.equal(await runBrew(refusing, shell(behave.succeed()), mash(13)), 5);
        assert.equal(log().state().batches.size, 0);
        assert.equal(f.lines.at(-1), `foedrum mash: ${line}`);
      });
    }

    it("labels a claimed order's Brewery issue once its question is answered, never the target issue", async () => {
      const web = { alias: 'web', intake: { labels: ['foedrum'] } };
      f.api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: [], author: 'ann', title: 'Dark theme', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark theme', body: 'Dark.' },
          ],
        },
      });
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = mashSetup({ config: config({}, web) });
      assert.equal(await runBrew(claimed, shell(behave.needInput([which(40)])), mash(40)), 4);
      const answers = [{ q: which(40).q, answer: 'stout' }];
      const answer = {
        kind: 'answer',
        batchId: 'web-7',
        by: 'ann',
        via: 'terminal',
        answers,
      } as const;
      const answered = createCommandLog({ store: f.store, recipes: claimed.recipes }).issue(
        answer,
        t0,
      );
      assert.equal(answered.kind, 'accepted', JSON.stringify(answered));
      const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
      const brew = { ...request, target: { issue: 40 } };
      assert.equal(await runBrew(claimed, again, brew), 0, f.lines.join('\n'));
      const recipes = (repo: string, issue: number) =>
        (f.api.issue(repo, issue)?.labels ?? []).filter((label) => label.startsWith('recipe:'));
      assert.deepStrictEqual(recipes('acme/brewery', 40), ['recipe:stout']);
      assert.deepStrictEqual(recipes('acme/web', 7), []);
    });

    describe('foedrum mash --override (ADR 0374)', () => {
      const override = (issue: number): BrewRequest => ({ ...mash(issue), override: true });
      /**
       * A shell whose Innkeeper asks which recipe brews `issue` and whose other steps behave as
       * `rest` does, under a lock of its own, as the next process of the same owner takes it.
       */
      const steps = (issue: number, rest: Behaviour) =>
        shell(rest, {
          lock: () => fakeLock('ann'),
          runner: () =>
            fakeBrewerRunner(({ ref }) => {
              f.started.push(`${ref.stepId}#${ref.attempt}`);
              return ref.stepId === 'innkeep' ? behave.needInput([which(issue)]) : rest;
            }),
        });
      const blocked = behave.blocked('environment', 'No database here');
      const answer = (setup: ServeSetup, batchId: string, issue: number, choice: string) => {
        const answered = createCommandLog({ store: f.store, recipes: setup.recipes }).issue(
          {
            kind: 'answer',
            batchId,
            by: 'ann',
            via: 'terminal',
            answers: [{ q: which(issue).q, answer: choice }],
          },
          t0,
        );
        assert.equal(answered.kind, 'accepted', JSON.stringify(answered));
      };
      const brew = (issue: number): BrewRequest => ({ ...request, target: { issue } });
      const recipeLabels = (issue: number) =>
        (f.api.issue('acme/brewery', issue)?.labels ?? []).filter((label) =>
          label.startsWith('recipe:'),
        );
      /** #12, labelled recipe:stout, brewed to Stuck at stout's first step. */
      const stuckOnStout = async (setup: ServeSetup): Promise<void> => {
        assert.equal(await runBrew(setup, steps(12, blocked), brew(12)), 3, f.lines.join('\n'));
        assert.equal(log().state().batches.get(breweryIdOf(12))?.lane.kind, 'stuck');
        assert.equal(log().state().batches.get(breweryIdOf(12))?.recipe?.name, 'stout');
      };

      it('foedrum mash --override on a Stuck batch with a recipe asks the Innkeeper again', async () => {
        const brewing = mashSetup();
        await stuckOnStout(brewing);
        const asks = steps(12, blocked);
        assert.equal(await runBrew(brewing, asks, override(12)), 4, f.lines.join('\n'));
        assert.equal(f.started.at(-1)?.startsWith('innkeep#'), true, f.started.join(' '));
        const batch = log().state().batches.get(breweryIdOf(12));
        assert.equal(batch?.recipe?.name, 'mash-in');
        assert.equal(batch?.recipe?.reason, 'the engineer ran foedrum mash --override');
        assert.deepStrictEqual([...log().state().batches.keys()], [breweryIdOf(12)]);
        assert.equal(
          f.lines.at(-1),
          'foedrum mash: answer them in order with foedrum answer 12 <answer 1>, then brew again',
        );
      });

      it('the answer to a re-mash restarts the batch on the chosen recipe from its first step', async () => {
        const brewing = mashSetup();
        await stuckOnStout(brewing);
        assert.equal(await runBrew(brewing, steps(12, blocked), override(12)), 4);
        answer(brewing, breweryIdOf(12), 12, 'mild');
        const before = f.started.length;
        const done = steps(12, behave.succeed());
        assert.equal(await runBrew(brewing, done, brew(12)), 0, f.lines.join('\n'));
        assert.equal(log().state().batches.get(breweryIdOf(12))?.recipe?.name, 'mild');
        // mild's first step, brew, runs again after stout's attempt and the Innkeeper's.
        assert.deepStrictEqual(f.started.slice(before), ['brew#2']);
      });

      it('a re-mash leaves the issue exactly one recipe label', async () => {
        const brewing = mashSetup();
        await stuckOnStout(brewing);
        assert.deepStrictEqual(recipeLabels(12), ['recipe:stout']);
        assert.equal(await runBrew(brewing, steps(12, blocked), override(12)), 4);
        answer(brewing, breweryIdOf(12), 12, 'mild');
        assert.equal(await runBrew(brewing, steps(12, blocked), brew(12)), 3, f.lines.join('\n'));
        assert.deepStrictEqual(recipeLabels(12), ['recipe:mild']);
      });

      it('a re-mash back to an earlier recipe labels the issue with it again', async () => {
        const brewing = mashSetup();
        // #13 has no label: the first mash's answer labels it.
        assert.equal(await runBrew(brewing, steps(13, blocked), mash(13)), 4, f.lines.join('\n'));
        answer(brewing, breweryIdOf(13), 13, 'stout');
        assert.equal(await runBrew(brewing, steps(13, blocked), brew(13)), 3, f.lines.join('\n'));
        assert.deepStrictEqual(recipeLabels(13), ['recipe:stout']);
        for (const choice of ['mild', 'stout']) {
          assert.equal(await runBrew(brewing, steps(13, blocked), override(13)), 4);
          answer(brewing, breweryIdOf(13), 13, choice);
          assert.equal(await runBrew(brewing, steps(13, blocked), brew(13)), 3);
          assert.equal(log().state().batches.get(breweryIdOf(13))?.recipe?.name, choice);
          assert.deepStrictEqual(recipeLabels(13), [`recipe:${choice}`], f.lines.join('\n'));
        }
      });

      it('foedrum mash --override on a batch waiting for a session asks the Innkeeper, not the session', async () => {
        const at = new Date(t0.getTime() + 3_600_000).toISOString();
        f.store.withTransaction((tx) => {
          tx.append({
            type: 'batch.ordered',
            batchId: breweryIdOf(12),
            order: { issue: 12 },
            routeBy: at,
          });
          tx.append({
            type: 'batch.recipe_chosen',
            batchId: breweryIdOf(12),
            recipe: 'stout',
            reason: 'label',
            source: 'label',
          });
          tx.append({
            type: 'step.scheduled',
            batchId: breweryIdOf(12),
            stepId: 'brew',
            attempt: 1,
            deadlineAt: at,
          });
          tx.append({ type: 'step.started', batchId: breweryIdOf(12), stepId: 'brew', attempt: 1 });
          tx.append({
            type: 'batch.stuck',
            batchId: breweryIdOf(12),
            reason: { kind: 'waiting_for_session', stepId: 'brew' },
            options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
            remindAt: at,
          });
        });
        const asks = steps(12, blocked);
        assert.equal(await runBrew(mashSetup(), asks, override(12)), 4, f.lines.join('\n'));
        assert.equal(log().state().batches.get(breweryIdOf(12))?.recipe?.name, 'mash-in');
        assert.deepStrictEqual(f.started, ['innkeep#1']);
      });

      it('foedrum mash --override on a Brewing batch is refused and names foedrum stop', async () => {
        log().issue({ kind: 'order', batchId: breweryIdOf(12), order: { issue: 12 } }, t0);
        const route = {
          kind: 'route',
          batchId: breweryIdOf(12),
          recipe: 'stout',
          reason: 'label',
        } as const;
        log().issue({ ...route, source: 'label' }, t0);
        assert.equal(log().state().batches.get(breweryIdOf(12))?.lane.kind, 'brewing');
        assert.equal(await runBrew(mashSetup(), steps(12, blocked), override(12)), 5);
        assert.deepStrictEqual(f.started, []);
        assert.equal(log().state().batches.get(breweryIdOf(12))?.recipe?.name, 'stout');
        assert.equal(
          f.lines.at(-1),
          'foedrum mash: #12 is brewing; foedrum stop 12 first, then foedrum mash 12 --override',
        );
      });

      it("foedrum mash --override --take on another driver's Brewing batch takes nothing over and names foedrum stop", async () => {
        log().issue({ kind: 'order', batchId: breweryIdOf(12), order: { issue: 12 } }, t0);
        const route = {
          kind: 'route',
          batchId: breweryIdOf(12),
          recipe: 'stout',
          reason: 'label',
        } as const;
        log().issue({ ...route, source: 'label' }, t0);
        const expiresAt = new Date(t0.getTime() + 60_000);
        f.store.withTransaction((tx) =>
          tx.putBatchLease({ batchId: breweryIdOf(12), owner: 'cellar', expiresAt }),
        );
        const take = { ...override(12), take: true } as const;
        assert.equal(await runBrew(mashSetup(), steps(12, blocked), take), 5);
        assert.equal(
          f.lines.at(-1),
          'foedrum mash: #12 is brewing; foedrum stop 12 first, then foedrum mash 12 --override',
        );
        assert.equal(f.leaseOf()?.owner, 'cellar');
        assert.equal(log().state().batches.get(breweryIdOf(12))?.takeover, undefined);
      });

      it('foedrum mash without --override on a batch with a recipe names the flag', async () => {
        const brewing = mashSetup();
        await stuckOnStout(brewing);
        const before = f.started.length;
        assert.equal(await runBrew(brewing, steps(12, blocked), mash(12)), 5);
        assert.equal(f.started.length, before);
        assert.equal(log().state().batches.get(breweryIdOf(12))?.recipe?.name, 'stout');
        assert.equal(
          f.lines.at(-1),
          'foedrum mash: #12 already brews the recipe stout; foedrum mash 12 --override asks the Innkeeper again, or foedrum recipe 12 <recipe> <reason> brews it with another',
        );
      });

      it('foedrum mash --override on a cancelled batch orders the issue again and asks the Innkeeper', async () => {
        log().issue({ kind: 'order', batchId: breweryIdOf(12), order: { issue: 12 } }, t0);
        const route = {
          kind: 'route',
          batchId: breweryIdOf(12),
          recipe: 'stout',
          reason: 'label',
        } as const;
        log().issue({ ...route, source: 'label' }, t0);
        log().issue({ kind: 'cancel', batchId: breweryIdOf(12), by: 'ann', via: 'terminal' }, t0);
        assert.equal(log().state().batches.get(breweryIdOf(12))?.lane.kind, 'cancelled');
        const asks = steps(12, blocked);
        assert.equal(await runBrew(mashSetup(), asks, override(12)), 4, f.lines.join('\n'));
        assert.deepStrictEqual(
          [...log().state().batches.keys()],
          [breweryIdOf(12), `${breweryIdOf(12)}-2`],
        );
        assert.equal(
          log()
            .state()
            .batches.get(`${breweryIdOf(12)}-2`)?.recipe?.name,
          'mash-in',
        );
        assert.ok(f.lines.includes('foedrum mash: ordered #12'), f.lines.join('\n'));
      });

      const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
      const pull = 'https://github.com/acme/web/pull/90';
      /** Order #12 on tap with an approved plan's sub-orders, as `then` leaves them. */
      const planned = (subOrders: readonly number[], then: (tx: Transaction) => void) =>
        f.store.withTransaction((tx) => {
          tx.append({
            type: 'batch.ordered',
            batchId: breweryIdOf(12),
            order: { issue: 12 },
            routeBy,
          });
          tx.append({
            type: 'order.decomposed',
            batchId: breweryIdOf(12),
            subOrders: subOrders.map((issue) => ({ issue, repo: 'acme/web' })),
            dependencies: [],
          });
          tx.append({ type: 'batch.on_tap', batchId: breweryIdOf(12), pullRequests: [] });
          then(tx);
        });
      const subOrdered = (tx: Transaction, issue: number) =>
        tx.append({
          type: 'batch.ordered',
          batchId: `${breweryIdOf(issue)}`,
          order: { issue },
          parentBatchId: breweryIdOf(12),
          routeBy,
        });

      it('foedrum mash --override refuses an issue on tap whose pull request is open, ordering nothing', async () => {
        f.store.withTransaction((tx) => {
          tx.append({
            type: 'batch.ordered',
            batchId: breweryIdOf(12),
            order: { issue: 12 },
            routeBy,
          });
          tx.append({ type: 'batch.on_tap', batchId: breweryIdOf(12), pullRequests: [pull] });
        });
        assert.equal(await runBrew(mashSetup(), steps(12, blocked), override(12)), 5);
        assert.deepStrictEqual([...log().state().batches.keys()], [breweryIdOf(12)]);
        assert.deepStrictEqual(f.started, []);
        assert.equal(
          f.lines.at(-1),
          `foedrum mash: #12 is on tap with a pull request with no recorded end, ${pull}: foedrum brew 12 or foedrum serve reads it if it ended; otherwise close it first`,
        );
      });

      it('foedrum mash --override refuses an order whose sub-order is not ended, naming it', async () => {
        planned([30, 31], (tx) => {
          subOrdered(tx, 30);
          subOrdered(tx, 31);
          tx.append({ type: 'batch.on_tap', batchId: breweryIdOf(31), pullRequests: [] });
        });
        assert.equal(await runBrew(mashSetup(), steps(12, blocked), override(12)), 5);
        assert.deepStrictEqual(
          [...log().state().batches.keys()],
          [breweryIdOf(12), breweryIdOf(30), breweryIdOf(31)],
        );
        assert.equal(
          f.lines.at(-1),
          "foedrum mash: #12's approved plan opened sub-orders #30; a new plan would leave them with no order: brew them, or foedrum recipe <sub-order> <recipe> <reason> changes one",
        );
      });

      it('foedrum mash --override refuses an order whose sub-order has an open pull request, naming it', async () => {
        planned([30], (tx) => {
          subOrdered(tx, 30);
          tx.append({ type: 'batch.on_tap', batchId: breweryIdOf(30), pullRequests: [pull] });
        });
        assert.equal(await runBrew(mashSetup(), steps(12, blocked), override(12)), 5);
        assert.deepStrictEqual(
          [...log().state().batches.keys()],
          [breweryIdOf(12), breweryIdOf(30)],
        );
        assert.equal(
          f.lines.at(-1),
          "foedrum mash: #12's approved plan opened sub-orders #30; a new plan would leave them with no order: brew them, or foedrum recipe <sub-order> <recipe> <reason> changes one",
        );
      });

      it('foedrum mash --override plans an order again whose sub-orders all ended', async () => {
        planned([30], (tx) => {
          subOrdered(tx, 30);
          tx.append({ type: 'batch.on_tap', batchId: breweryIdOf(30), pullRequests: [] });
        });
        const asks = steps(12, blocked);
        assert.equal(await runBrew(mashSetup(), asks, override(12)), 4, f.lines.join('\n'));
        assert.equal(
          log()
            .state()
            .batches.get(`${breweryIdOf(12)}-2`)?.recipe?.name,
          'mash-in',
        );
      });

      it('foedrum mash --override plans an order again whose sub-order was cancelled: regression test', async () => {
        planned([30], (tx) => {
          subOrdered(tx, 30);
          tx.append({
            type: 'batch.cancelled',
            batchId: breweryIdOf(30),
            by: 'ann',
            via: 'terminal',
          });
        });
        const asks = steps(12, blocked);
        assert.equal(await runBrew(mashSetup(), asks, override(12)), 4, f.lines.join('\n'));
        assert.equal(
          log()
            .state()
            .batches.get(`${breweryIdOf(12)}-2`)?.recipe?.name,
          'mash-in',
        );
      });

      it("foedrum mash --override of a Stuck batch another driver holds names the re-mash's takeover: regression test", async () => {
        const brewing = mashSetup();
        await stuckOnStout(brewing);
        const expiresAt = new Date(t0.getTime() + 60_000);
        f.store.withTransaction((tx) =>
          tx.putBatchLease({ batchId: breweryIdOf(12), owner: 'cellar', expiresAt }),
        );
        const before = f.started.length;
        assert.equal(await runBrew(brewing, steps(12, blocked), override(12)), 5);
        assert.equal(f.started.length, before);
        assert.equal(
          f.lines.at(-1),
          `foedrum mash: #12 is driven by cellar until ${expiresAt.toISOString()}, when its lease ends by itself; foedrum mash 12 --override --take takes it over now`,
        );
      });

      it('foedrum mash --override restarts a Conditioning batch on mash-in, ordering no second batch: regression test', async () => {
        f.store.withTransaction((tx) => {
          tx.append({
            type: 'batch.ordered',
            batchId: breweryIdOf(12),
            order: { issue: 12 },
            routeBy,
          });
          tx.append({
            type: 'batch.recipe_chosen',
            batchId: breweryIdOf(12),
            recipe: 'stout',
            reason: 'label',
            source: 'label',
          });
          tx.append({
            type: 'batch.waiting',
            batchId: breweryIdOf(12),
            on: { kind: 'merge', pullRequest: pull },
            remindAt: routeBy,
          });
        });
        assert.equal(log().state().batches.get(breweryIdOf(12))?.lane.kind, 'conditioning');
        const asks = steps(12, blocked);
        assert.equal(await runBrew(mashSetup(), asks, override(12)), 4, f.lines.join('\n'));
        assert.deepStrictEqual([...log().state().batches.keys()], [breweryIdOf(12)]);
        assert.equal(log().state().batches.get(breweryIdOf(12))?.recipe?.name, 'mash-in');
      });

      it('foedrum mash --override refuses a batch Stuck on a changed order, which offers no recipe: regression test', async () => {
        f.store.withTransaction((tx) => {
          tx.append({
            type: 'batch.ordered',
            batchId: breweryIdOf(12),
            order: { issue: 12 },
            routeBy,
          });
          tx.append({
            type: 'batch.recipe_chosen',
            batchId: breweryIdOf(12),
            recipe: 'stout',
            reason: 'label',
            source: 'label',
          });
          tx.append({
            type: 'step.scheduled',
            batchId: breweryIdOf(12),
            stepId: 'brew',
            attempt: 1,
            deadlineAt: routeBy,
          });
          tx.append({ type: 'step.started', batchId: breweryIdOf(12), stepId: 'brew', attempt: 1 });
          tx.append({
            type: 'batch.stuck',
            batchId: breweryIdOf(12),
            reason: {
              kind: 'order_changed',
              stepId: 'brew',
              changes: [{ what: 'title', at: routeBy }],
              more: 0,
              upTo: routeBy,
            },
            options: ['answer', 'cancel'],
            remindAt: routeBy,
          });
        });
        assert.equal(await runBrew(mashSetup(), steps(12, blocked), override(12)), 5);
        assert.deepStrictEqual(f.started, []);
        assert.equal(log().state().batches.get(breweryIdOf(12))?.recipe?.name, 'stout');
        assert.equal(
          f.lines.at(-1),
          `foedrum mash: batch ${breweryIdOf(12)} does not offer recipe`,
        );
      });

      it("foedrum mash --override refuses an order whose batch is Stuck after its plan's breakdown while a sub-order is not ended: regression test", async () => {
        f.store.withTransaction((tx) => {
          tx.append({
            type: 'batch.ordered',
            batchId: breweryIdOf(12),
            order: { issue: 12 },
            routeBy,
          });
          tx.append({
            type: 'batch.recipe_chosen',
            batchId: breweryIdOf(12),
            recipe: 'stout',
            reason: 'label',
            source: 'label',
          });
          tx.append({
            type: 'order.decomposed',
            batchId: breweryIdOf(12),
            subOrders: [{ issue: 30, repo: 'acme/web' }],
            dependencies: [],
          });
          subOrdered(tx, 30);
          tx.append({
            type: 'step.scheduled',
            batchId: breweryIdOf(12),
            stepId: 'brew',
            attempt: 1,
            deadlineAt: routeBy,
          });
          tx.append({ type: 'step.started', batchId: breweryIdOf(12), stepId: 'brew', attempt: 1 });
          tx.append({
            type: 'batch.stuck',
            batchId: breweryIdOf(12),
            reason: { kind: 'waiting_for_session', stepId: 'brew' },
            options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
            remindAt: routeBy,
          });
        });
        assert.equal(log().state().batches.get(breweryIdOf(12))?.lane.kind, 'stuck');
        assert.equal(await runBrew(mashSetup(), steps(12, blocked), override(12)), 5);
        assert.deepStrictEqual(f.started, []);
        assert.equal(log().state().batches.get(breweryIdOf(12))?.recipe?.name, 'stout');
        assert.equal(
          f.lines.at(-1),
          "foedrum mash: #12's approved plan opened sub-orders #30; a new plan would leave them with no order: brew them, or foedrum recipe <sub-order> <recipe> <reason> changes one",
        );
      });

      it('foedrum mash --override plans an order again whose live sub-order a later plan left out', async () => {
        planned([30, 31], (tx) => {
          subOrdered(tx, 31);
          // A later breakdown of the same plan leaves #31 out: it is marked cancelled (ADR 0211), and
          // the order's sub-orders are the latest breakdown's, which no longer lists it.
          tx.append({
            type: 'order.decomposed',
            batchId: breweryIdOf(12),
            subOrders: [{ issue: 30, repo: 'acme/web' }],
            dependencies: [],
          });
        });
        assert.equal(log().state().subOrders.get(31)?.cancelled, true);
        const asks = steps(12, blocked);
        assert.equal(await runBrew(mashSetup(), asks, override(12)), 4, f.lines.join('\n'));
        assert.equal(
          log()
            .state()
            .batches.get(`${breweryIdOf(12)}-2`)?.recipe?.name,
          'mash-in',
        );
      });
    });
  });
});
