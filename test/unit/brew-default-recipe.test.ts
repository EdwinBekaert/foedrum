// `foedrum brew` on an issue with no recipe label runs the Brewery's default recipe, `mash-in`
// unless foedrum.jsonc's `defaultRecipe` names another of type `mash` (ADR 0370); `foedrum serve`
// still waits for such an issue's routing deadline. serve's shell with an in-memory store, fake
// worktrees, a fake GitHub and the scripted runner; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import { diagnose } from '../../src/cli/doctor.ts';
import { type ServeSetupResult, serveSetup } from '../../src/cli/serve-config.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { linux } from '../helpers/doctor-facts.ts';
import { behave } from '../helpers/fake-brewer-runner.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';

// A second recipe like stout, so the Innkeeper has two to offer beside porter and nip.
const mild = JSON.stringify({ ...JSON.parse(recipe), name: 'mild', description: 'A mild.' });
const web = { alias: 'web', intake: { labels: ['foedrum'] } };

/**
 * The test Brewery with Foedrum's defaults under it, mash-in, mash and the Innkeeper among them,
 * in the work root `workRoot`; with `only`, the Brewery's recipes are that one, and Foedrum's are
 * mash-in alone.
 */
const defaultSetup = (
  workRoot: string,
  fields: { config?: string; only?: string } = {},
): ServeSetupResult => {
  const inputs = serveInputs();
  const { defaults = {} } = readBreweryFiles(join(workRoot, 'no-brewery'));
  const own = [...(inputs.files.brewery.recipes ?? []), { path: 'recipes/mild.jsonc', text: mild }];
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

  it('a Brewery whose default cannot run says so in one line', async () => {
    const one = ready({ only: 'stout' });
    assert.equal(await runBrew(one, shell(behave.succeed()), brew(13)), 5, f.lines.join('\n'));
    assert.equal(log().state().batches.size, 0);
    assert.equal(
      f.lines.at(-1),
      `foedrum brew: #13 has no recipe:<name> label, and the Brewery's default recipe mash-in has one recipe to offer, stout; label it with the recipe to brew it with, or choose one with foedrum recipe 13 <recipe> "<reason>"`,
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
});
