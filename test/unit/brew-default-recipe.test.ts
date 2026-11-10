// `foedrum brew` on an issue with no recipe label runs the Brewery's default recipe, `mash-in`
// unless foedrum.jsonc's `defaultRecipe` names another of type `mash` (ADR 0370); `foedrum serve`
// still waits for such an issue's routing deadline. serve's shell with an in-memory store, fake
// worktrees, a fake GitHub and the scripted runner; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import { diagnose } from '../../src/cli/doctor.ts';
import { runServe } from '../../src/cli/serve.ts';
import { type ServeSetupResult, serveSetup } from '../../src/cli/serve-config.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { linux } from '../helpers/doctor-facts.ts';
import { behave } from '../helpers/fake-brewer-runner.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture } from '../helpers/serve-fixture.ts';

// A second recipe like stout, so the Innkeeper has two to offer beside porter and nip.
const mild = JSON.stringify({ ...JSON.parse(recipe), name: 'mild', description: 'A mild.' });
// A Brewery's own mash-in that builds, replacing Foedrum's (ADR 0098).
const buildingMashIn = JSON.stringify({ ...JSON.parse(recipe), name: 'mash-in' });
const web = { alias: 'web', intake: { labels: ['foedrum'] } };

/**
 * The test Brewery with Foedrum's defaults under it, mash-in, mash and the Innkeeper among them,
 * in the work root `workRoot`; with `only`, the Brewery's recipes are that one, and Foedrum's are
 * mash-in alone; `own` adds recipe files of the Brewery's own.
 */
const defaultSetup = (
  workRoot: string,
  fields: { config?: string; only?: string; own?: { path: string; text: string }[] } = {},
): ServeSetupResult => {
  const inputs = serveInputs();
  const { defaults = {} } = readBreweryFiles(join(workRoot, 'no-brewery'));
  const own = [
    ...(inputs.files.brewery.recipes ?? []),
    { path: 'recipes/mild.jsonc', text: mild },
    ...(fields.own ?? []),
  ];
  return serveSetup(
    serveInputs({
      files: {
        ...inputs.files,
        ...(fields.config === undefined ? {} : { config: fields.config }),
        local: local({ workRoot }),
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
                  recipes: (defaults.recipes ?? []).filter(({ path }) =>
                    path.endsWith('/mash-in.jsonc'),
                  ),
                },
        },
      },
    }),
  );
};

/** The router's choice of the default recipe, as the batch records it (ADR 0370). */
const byDefault = (name: string) => ({
  name,
  type: 'mash',
  reason: "the Brewery's default recipe, for an issue with no recipe label",
  source: 'router',
});

describe('runBrew on an issue with no recipe label (ADR 0370)', () => {
  const f = brewFixture();
  const { log, shell } = f;
  const ready = (fields?: Parameters<typeof defaultSetup>[1]) => {
    const result = defaultSetup(f.dir.path, fields);
    return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
  };
  const which = (issue: number): Question => ({
    q: `Which recipe brews #${issue}? Suggested: mild: one small change`,
    options: ['stout', 'mild'],
    recommended: 'mild',
    whyBlocking: 'The recipe decides what runs next',
  });
  const brew = (issue: number): BrewRequest => ({ ...request, target: { issue } });
  const recipeLabels = (repo: string, issue: number) =>
    (f.api.issue(repo, issue)?.labels ?? []).filter((label) => label.startsWith('recipe:'));

  it("foedrum brew on an issue with no label routes its batch to mash-in and ends at the Innkeeper's question", async () => {
    const asks = shell(behave.needInput([which(13)]));
    assert.equal(await runBrew(ready(), asks, brew(13)), 4, f.lines.join('\n'));
    assert.deepStrictEqual(f.started, ['innkeep#1']);
    assert.deepStrictEqual(log().state().batches.get('13-1')?.recipe, byDefault('mash-in'));
    assert.ok(f.lines.includes('foedrum brew: ordered #13'), f.lines.join('\n'));
    assert.ok(
      f.lines.includes('foedrum brew: routed #13 to the recipe mash-in'),
      f.lines.join('\n'),
    );
    assert.equal(
      f.lines.at(-1),
      'foedrum brew: answer them in order with foedrum answer 13 <answer 1>, then brew again',
    );
    // A router's choice labels nothing: the issue's next order is routed as it is (ADR 0370).
    assert.deepStrictEqual(recipeLabels('acme/brewery', 13), []);
  });

  it('foedrum brew on an unlabelled issue runs the default recipe foedrum.jsonc names', async () => {
    const named = ready({ config: config({ defaultRecipe: 'mash' }) });
    const asks = shell(behave.needInput([which(13)]));
    await runBrew(named, asks, brew(13));
    assert.deepStrictEqual(log().state().batches.get('13-1')?.recipe, byDefault('mash'));
    assert.equal(f.started[0], 'plan#1', f.lines.join('\n'));
  });

  it('foedrum brew on an Ordered batch with no label runs the default recipe, ordering it not again', async () => {
    log().issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
    const asks = shell(behave.needInput([which(13)]));
    assert.equal(await runBrew(ready(), asks, brew(13)), 4, f.lines.join('\n'));
    assert.deepStrictEqual(log().state().batches.get('13-1')?.recipe, byDefault('mash-in'));
    assert.ok(!f.lines.some((line) => line.includes('ordered #13')), f.lines.join('\n'));
  });

  it('foedrum brew on a claimed order whose Brewery issue has no label runs the default recipe', async () => {
    f.api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [{ number: 40, labels: [], author: 'ann', title: 'Dark', body: 'web#7' }],
        'acme/web': [{ number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark' }],
      },
    });
    log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
    const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
    log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
    const claimed = ready({ config: config({}, web) });
    const asks = shell(behave.needInput([which(40)]));
    assert.equal(await runBrew(claimed, asks, brew(40)), 4, f.lines.join('\n'));
    assert.deepStrictEqual(log().state().batches.get('web-7')?.recipe, byDefault('mash-in'));
    assert.deepStrictEqual(recipeLabels('acme/brewery', 40), []);
  });

  it('foedrum brew on a claimed issue opens its Brewery issue and runs the default recipe there', async () => {
    f.api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/web': [{ number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark', body: 'x' }],
      },
    });
    const claimed = ready({ config: config({}, web) });
    const asks = shell(behave.needInput([which(1)]));
    const fresh = { ...request, target: { alias: 'web', issue: 7 } };
    assert.equal(await runBrew(claimed, asks, fresh), 4, f.lines.join('\n'));
    assert.equal(f.api.issues['acme/brewery']?.length, 1, 'its Brewery issue is opened');
    assert.deepStrictEqual(log().state().batches.get('web-7')?.recipe, byDefault('mash-in'));
    assert.deepStrictEqual(f.started, ['innkeep#1']);
  });

  it('an issue with two recipe labels, or a label naming a recipe the Brewery lacks, is still refused: regression test', async () => {
    const lines: [number, string][] = [
      [14, 'foedrum brew: #14 carries recipe:stout and recipe:porter; give it one recipe label'],
      [15, 'foedrum brew: #15 carries recipe:stoutt, which names no recipe of this Brewery'],
    ];
    for (const [issue, line] of lines) {
      // Each brew is a process of its own, which takes the owner's lock again.
      const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
      assert.equal(await runBrew(ready(), again, brew(issue)), 5, f.lines.join('\n'));
      assert.equal(f.lines.at(-1), line);
    }
    assert.equal(log().state().batches.size, 0);
    assert.deepStrictEqual(f.started, []);
  });

  it('a Brewery whose default cannot run says so in one line', async () => {
    const one = ready({ only: 'stout' });
    assert.equal(await runBrew(one, shell(behave.succeed()), brew(13)), 5, f.lines.join('\n'));
    assert.equal(log().state().batches.size, 0);
    assert.equal(
      f.lines.at(-1),
      `foedrum brew: #13 has no recipe:<name> label, and the Brewery's default recipe mash-in has one recipe to offer, stout; label it with the recipe to brew it with, or choose one with foedrum recipe 13 <recipe> "<reason>"`,
    );
  });

  it('a left-out default whose mash-in the Brewery replaced with a recipe of type brew is refused in one line', async () => {
    const building = ready({ own: [{ path: 'recipes/mash-in.jsonc', text: buildingMashIn }] });
    assert.equal(await runBrew(building, shell(behave.succeed()), brew(13)), 5, f.lines.join('\n'));
    assert.equal(log().state().batches.size, 0);
    assert.deepStrictEqual(f.started, []);
    assert.equal(
      f.lines.at(-1),
      `foedrum brew: #13 has no recipe:<name> label, and the Brewery's default recipe mash-in is of type brew; label it with the recipe to brew it with, or choose one with foedrum recipe 13 <recipe> "<reason>"`,
    );
  });
});

describe('the default recipe in foedrum.jsonc (ADR 0370)', () => {
  const workRoot = resolve('work', 'root');
  const refusals: [string, string][] = [
    [
      'stout',
      "foedrum.jsonc's defaultRecipe names stout, of type brew: name a recipe of type mash, or leave it out for mash-in",
    ],
    [
      'stoutt',
      "foedrum.jsonc's defaultRecipe names stoutt, which is no recipe of this Brewery: name a recipe of type mash, or leave it out for mash-in",
    ],
  ];

  it('a default recipe that is not of type mash is refused with a line that names the fix', () => {
    const [name, line] = refusals[0] ?? assert.fail();
    const result = defaultSetup(workRoot, { config: config({ defaultRecipe: name }) });
    assert.deepStrictEqual(result, { kind: 'refused', problems: [line] });
  });

  it('a default recipe the Brewery lacks is refused with a line of its own', () => {
    const [name, line] = refusals[1] ?? assert.fail();
    const result = defaultSetup(workRoot, { config: config({ defaultRecipe: name }) });
    assert.deepStrictEqual(result, { kind: 'refused', problems: [line] });
  });

  for (const [name, line] of refusals) {
    it(`foedrum doctor gives the same line for a default recipe ${name}`, () => {
      const brewery = serveInputs().files.brewery;
      const diagnosis = diagnose({
        ...linux(),
        config: config({ defaultRecipe: name }),
        brewery,
      });
      assert.equal(diagnosis.ok, false);
      assert.deepStrictEqual(
        diagnosis.problems.map(({ what, fix }) => `${what}: ${fix}`),
        [line],
      );
    });
  }

  it('a default recipe of type mash, or none, is no problem: regression test', () => {
    for (const fields of [{ defaultRecipe: 'mash' }, {}]) {
      const result = defaultSetup(workRoot, { config: config(fields) });
      assert.equal(result.kind, 'ready', JSON.stringify(result));
    }
  });
});

describe('runServe on an issue with no recipe label (ADR 0370)', () => {
  const f = serveFixture();
  const { shell } = f;

  it("foedrum serve still waits for an unlabelled issue's routing deadline: regression test", async () => {
    const result = defaultSetup(f.dir.path, { config: config({ defaultRecipe: 'mash-in' }) });
    f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    const by = { by: 'ann', via: 'terminal' } as const;
    log.issue({ kind: 'order_again', batchId: '13-1', order: { issue: 13 }, ...by }, t0);
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [{ number: 13, labels: [], author: 'ann', title: 'Unlabelled' }],
      },
    });
    let now = t0.getTime();
    const lane = () => log.state().batches.get('13-1')?.lane;
    const waits = {
      clock: () => new Date(now),
      wait: async () => {
        // An hour a tick, past the routing deadline in a day (ADR 0032).
        now += 3_600_000;
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (lane()?.kind !== 'ordered' || now > t0.getTime() + 72 * 3_600_000) {
          f.controller.abort();
        }
      },
    };
    assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...waits })), 0);
    const reached = lane();
    assert.deepStrictEqual(
      { lane: reached?.kind, reason: reached?.kind === 'stuck' ? reached.reason.kind : undefined },
      { lane: 'stuck', reason: 'routing' },
      f.lines.join('\n'),
    );
    assert.equal(log.state().batches.get('13-1')?.recipe, undefined);
  });
});
