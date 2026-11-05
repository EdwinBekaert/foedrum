// `foedrum mash` through runBrew (ADR 0232): it brews an order's planning steps as a driver of its
// own. serve's shell with an in-memory store, fake worktrees, a fake GitHub and the scripted runner;
// no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';

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
      assert.deepStrictEqual(log().state().batches.get('13-1')?.recipe, {
        name: 'mash-in',
        reason: 'the engineer ran foedrum mash',
        source: 'human',
        by: 'ann',
        via: 'terminal',
      });
      assert.ok(f.lines.includes('foedrum mash: ordered #13 as batch 13-1'), f.lines.join('\n'));
      assert.deepStrictEqual(f.lines.slice(-4), [
        'foedrum mash: batch 13-1 needs input at innkeep:',
        'foedrum mash:   1. Which recipe brews #13? Suggested: mild: one small change (stout, mild; recommended: mild)',
        'foedrum mash:      why it blocks: The recipe decides what runs next',
        'foedrum mash: answer them in order with foedrum answer 13-1 <answer 1>, then brew again',
      ]);
    });

    for (const choice of ['stout', 'mild']) {
      it(`labels the issue recipe:${choice} once when the answer is ${choice}, and brews it from its first step`, async () => {
        const brewing = mashSetup();
        assert.equal(await runBrew(brewing, shell(behave.needInput([which(13)])), mash(13)), 4);
        const answered = createCommandLog({ store: f.store, recipes: brewing.recipes }).issue(
          {
            kind: 'answer',
            batchId: '13-1',
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
        assert.equal(log().state().batches.get('13-1')?.recipe?.name, choice);
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
        const id = `${issue}-1`;
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
      mashLog.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      mashLog.issue(
        { kind: 'route', batchId: '13-1', recipe: 'mash', reason: 'label', source: 'label' },
        t0,
      );
      const plans = behave.succeedWith({ assumptions: ['Kept the flag'], subOrders: [subOrder] });
      await runBrew(brewing, shell(plans), { ...request, target: { issue: 13 } });
      const bodies = (f.api.comments.get('acme/brewery#13') ?? []).map(({ body }) => body);
      const link = `[13-1/plan-1.md](<https://github.localhost/${f.setup.brewery}/blob/foedrum/state/batches/13-1/plan-1.md>)`;
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
        { kind: 'order', batchId: '13-1', order: { issue: 13 } },
        { kind: 'route', batchId: '13-1', recipe: 'mash', reason: 'label', source: 'label' },
      ] as const) {
        const decision = mashLog.issue(command, t0);
        assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      }
      const plans = behave.succeedWith({ assumptions: ['Kept the flag'], subOrders: [subOrder] });
      await runBrew(brewing, shell(plans), { ...request, target: { issue: 13 } });
      const link = `[13-1/plan-1.md](<https://github.com/${f.setup.brewery}/blob/foedrum/state/batches/13-1/plan-1.md>)`;
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
      const target = { ...request, target: { alias: 'web', issue: 7 } };
      assert.equal(await runBrew(claimed, shell(plans), target), 3, f.lines.join('\n'));
      const bodies = (f.api.comments.get('acme/brewery#40') ?? []).map(({ body }) => body);
      const plan = (f.api.comments.get('acme/brewery#40') ?? []).find(({ body }) =>
        body.includes('plan of batch'),
      );
      const url = `https://github.localhost/${claimed.brewery}/issues/40#issuecomment-${plan?.id}`;
      assert.ok(
        bodies.some((body) => body.includes(`is ready for your review: [plan comment](<${url}>)`)),
        bodies.join('\n---\n'),
      );
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
      assert.equal(log().state().batches.get('web-7')?.recipe?.name, 'mash-in');
      assert.ok(
        f.lines.includes('foedrum mash: ordered acme/web#7 as batch web-7'),
        f.lines.join('\n'),
      );
    });

    it('refuses a batch that started a recipe, naming foedrum recipe: exit 5', async () => {
      log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
      const route = { kind: 'route', batchId: '12-1', recipe: 'stout', reason: 'label' } as const;
      log().issue({ ...route, source: 'label' }, t0);
      assert.equal(await runBrew(mashSetup(), shell(behave.succeed()), mash(12)), 5);
      assert.deepStrictEqual(f.started, []);
      assert.equal(
        f.lines.at(-1),
        'foedrum mash: batch 12-1 of #12 already brews the recipe stout; foedrum recipe 12-1 <recipe> <reason> brews it with another',
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
      const brew = { ...request, target: { alias: 'web', issue: 7 } };
      assert.equal(await runBrew(claimed, again, brew), 0, f.lines.join('\n'));
      const recipes = (repo: string, issue: number) =>
        (f.api.issue(repo, issue)?.labels ?? []).filter((label) => label.startsWith('recipe:'));
      assert.deepStrictEqual(recipes('acme/brewery', 40), ['recipe:stout']);
      assert.deepStrictEqual(recipes('acme/web', 7), []);
    });
  });
});
