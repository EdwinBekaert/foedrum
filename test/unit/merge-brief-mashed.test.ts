// The merge brief of a batch that was mashed (ADR 0225, ADR 0232, #867): Mash-in's Innkeeper asked
// which recipe brews the order, the answer moved the batch to a building recipe, and the batch's
// steps keep the Innkeeper's attempt beside that recipe's. The recipes are the loaded ones, since a
// loaded recipe throws for a step it lacks; the command log is the real one on a store in memory
// and a fake code host takes the comments (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { baseConflictEffects } from '../../src/engine/base-check.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { effectMarker } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import type { DriverEffects } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { type MergeBriefHost, mergeBriefEffects } from '../../src/engine/merge-brief-post.ts';
import { mergedCheckStep } from '../../src/engine/merged-checks.ts';
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { HeadCheck } from '../../src/schemas/events.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import type { PushResult } from '../../src/schemas/store.ts';
import { recipeText } from '../helpers/brewery-files.ts';

const url = 'https://github.com/acme/web/pull/12';
const now = new Date('2026-10-26T09:00:00.000Z');
const head = 'a'.repeat(40);
const batchId = 'web-7';

// A building recipe of Brewery's own beside Foedrum's defaults: mash-in and its Innkeeper are the
// defaults', and the Cellarman commits with no red proof before it, so it says testFirst: false.
const porter = recipeText(
  'porter',
  [
    { id: 'implement', brewer: 'cellarman' },
    { id: 'open', action: 'openPullRequest' },
  ],
  { testFirst: false },
);
const loaded = loadRecipes({
  ...readBreweryFiles(join(import.meta.dirname, '..', '..', 'no-brewery')),
  recipes: [{ path: 'recipes/porter.jsonc', text: porter }],
});
if (!loaded.valid) throw new Error(loaded.problems.join('\n'));
const { recipes } = loaded;

const which: Question = {
  q: 'Which recipe brews #7? Suggested: porter: one small change',
  options: ['porter', 'nip'],
  recommended: 'porter',
  whyBlocking: 'The recipe decides what runs next',
};
const done: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const passed = (name: string): HeadCheck => ({ name, kind: 'check_run', conclusion: 'success' });

/** A code host of one pull request that keeps the comments made on it. */
const fakeHost = (title = 'Add a --json flag') => {
  const comments: { id: number; body: string }[] = [];
  let made = 100;
  const host: MergeBriefHost = {
    find: async (_repo, _number, marker) => comments.find(({ body }) => body.endsWith(marker)),
    create: async (_repo, _number, body) => {
      made++;
      comments.push({ id: made, body });
      return made;
    },
    title: async () => title,
    hidden: async () => 'shown',
    hide: async () => 'hidden',
  };
  return { host, comments };
};

describe('the merge brief of a batch mashed to a building recipe (#867)', () => {
  let store: EventStore;
  let log: CommandLog;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
  });
  afterEach(() => store.close());

  const accept = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const ledger = (key: Parameters<typeof effectKey.encode>[0], result: unknown): void =>
    accept({
      kind: 'record',
      event: { type: 'effect.applied', key: effectKey.encode(key), result },
    });
  /** The scheduled attempt of `stepId`, started and ended with `ending`. */
  const run = (stepId: string, ending: Ending): void => {
    const attempts = log.state().batches.get(batchId)?.steps.get(stepId)?.attempts;
    const attempt = Math.max(...(attempts?.keys() ?? []));
    assert.equal(attempts?.get(attempt)?.phase, 'scheduled', `${stepId} is scheduled`);
    const ref = { batchId, stepId, attempt };
    accept({ kind: 'record', event: { type: 'step.started', ...ref } });
    accept({ kind: 'finish', ...ref, ending });
  };
  /** The batch routed to mash-in, the Innkeeper's question answered with `recipe`. */
  const mashed = (recipe = 'porter'): void => {
    accept({ kind: 'order', batchId, order: { issue: 7 } });
    accept({ kind: 'route', batchId, recipe: 'mash-in', reason: 'label', source: 'label' });
    run('innkeep', { kind: 'needs_input', questions: [which] });
    accept({
      kind: 'answer',
      batchId,
      by: 'ann',
      via: 'terminal',
      answers: [{ q: which.q, answer: recipe }],
    });
  };
  /** Porter's steps of the batch routed to it, to On tap: its pull request opened on `head`. */
  const porterToOpen = (): void => {
    run('implement', done);
    const pushed: PushResult = { branch: 'foedrum/web-7/acme.web', commit: head, from: 'start' };
    const attempt = 1;
    accept({ kind: 'record', event: { type: 'step.started', batchId, stepId: 'open', attempt } });
    ledger(pushKey(batchId, 1), pushed);
    ledger(pullRequestKey(batchId), url);
    accept({ kind: 'finish', batchId, stepId: 'open', attempt, ending: done });
  };
  const checksFinished = (): void =>
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.checks_finished',
        batchId,
        pullRequest: url,
        head,
        checks: [passed('ci/build')],
      },
    });
  /** The mashed batch brewed to On tap, every check on its head finished. */
  const onTap = (): void => {
    mashed();
    porterToOpen();
    checksFinished();
  };
  const effectsOf = (host: MergeBriefHost): DriverEffects => mergeBriefEffects({ host, recipes });
  /** What a driver does with each due brief: found, else posted; then recorded in the ledger. */
  const post = async (effects: DriverEffects): Promise<string[]> => {
    const keys = effects.due(log.state(), batchId);
    for (const key of keys) {
      const encoded = effectKey.encode(key);
      const found = await effects.target.find(encoded);
      const result = found === undefined ? await effects.target.apply(encoded) : found.result;
      accept({ kind: 'record', event: { type: 'effect.applied', key: encoded, result } });
    }
    return keys.map(({ effect }) => effect);
  };

  it('has the brief due once the checks on its head finished, though the batch ran innkeep under mash-in', () => {
    onTap();
    const keys = effectsOf(fakeHost().host).due(log.state(), batchId);
    assert.deepStrictEqual(
      keys.map(({ effect }) => effect),
      ['brief.1'],
    );
  });

  it('posts a brief that reads sensibly with innkeep in its history: never that it did not run or pass', async () => {
    onTap();
    const { host, comments } = fakeHost();
    assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
    const [comment] = comments;
    assert.ok(comment);
    const marker = effectMarker(effectKey.encode({ batchId, effect: 'brief.1' }));
    assert.ok(comment.body.startsWith('### Merge? Add a --json flag @ `aaaaaaaa`\n'));
    assert.ok(comment.body.endsWith(marker));
    assert.match(comment.body, /\*\*Ready to merge\.\*\*/);
    assert.match(comment.body, /- ✅ ci\/build \(success\)/);
    assert.doesNotMatch(comment.body, /`innkeep`: (not run|did not pass)/);
  });

  it('reads the mashed batch for its merged-check step and base conflict posts with no error: regression test', () => {
    onTap();
    const found = log.state().batches.get(batchId);
    assert.ok(found);
    // Porter's last check before its pull request: it has none, so none merges the base.
    assert.equal(mergedCheckStep(recipes, loaded.checks, found), undefined);
    const marks = {
      findComment: async () => undefined,
      comment: async () => 1,
    };
    assert.deepStrictEqual(baseConflictEffects({ marks, recipes }).due(log.state(), batchId), []);
  });

  it('posts the brief of a batch routed straight to porter, as before: regression test', async () => {
    accept({ kind: 'order', batchId, order: { issue: 7 } });
    accept({ kind: 'route', batchId, recipe: 'porter', reason: 'label', source: 'label' });
    porterToOpen();
    checksFinished();
    const { host, comments } = fakeHost();
    assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
    assert.match(comments[0]?.body ?? '', /\*\*Ready to merge\.\*\*/);
    assert.doesNotMatch(comments[0]?.body ?? '', /`implement`: (not run|did not pass)/);
  });
});
