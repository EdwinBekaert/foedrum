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
import type { GravityReading, HeadCheck } from '../../src/schemas/events.ts';
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
// A Taster before its batch moved on: of a plan, since no step before it commits.
const earlierTaster = { brewer: 'taster', lens: 'plan/naive-reader' };
const ask = { id: 'ask', brewer: 'cellarman' };
const open = { id: 'open', action: 'openPullRequest' };
const diffTaster = (id: string) => ({ id, brewer: 'taster', lens: 'diff/correctness' });
const building = (name: string, steps: readonly unknown[]) => ({
  path: `recipes/${name}.jsonc`,
  text: recipeText(name, steps, { testFirst: false }),
});
const loaded = loadRecipes({
  ...readBreweryFiles(join(import.meta.dirname, '..', '..', 'no-brewery')),
  recipes: [
    { path: 'recipes/porter.jsonc', text: porter },
    building('reviewed', [{ id: 'old-taster', ...earlierTaster }, ask, open]),
    building('tasted', [{ id: 'implement', brewer: 'cellarman' }, diffTaster('new-taster'), open]),
    building('plain-taste', [{ id: 'taste', ...earlierTaster }, ask, open]),
    building('group-taste', [
      { id: 'implement', brewer: 'cellarman' },
      { id: 'taste', parallel: [diffTaster('one'), diffTaster('two')] },
      open,
    ]),
  ],
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
const tasted = (risk: string): Ending => ({
  kind: 'succeeded',
  output: {
    status: 'done',
    summary: 'Tasted',
    assumptions: [],
    verdict: 'approve',
    findings: [],
    riskLeft: [risk],
  },
});
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
  /** The scheduled attempt of `stepId`, started (at `commit`) and ended with `ending`. */
  const run = (
    stepId: string,
    ending: Ending,
    { readings, commit }: { readings?: GravityReading[]; commit?: string } = {},
  ): void => {
    const attempts = log.state().batches.get(batchId)?.steps.get(stepId)?.attempts;
    const attempt = Math.max(...(attempts?.keys() ?? []));
    assert.equal(attempts?.get(attempt)?.phase, 'scheduled', `${stepId} is scheduled`);
    const ref = { batchId, stepId, attempt };
    const worktree =
      commit === undefined
        ? {}
        : { worktree: { repo: 'acme/web', path: `/w/${stepId}`, branch: stepId, commit } };
    accept({ kind: 'record', event: { type: 'step.started', ...ref, ...worktree } });
    accept({ kind: 'finish', ...ref, ending, ...(readings === undefined ? {} : { readings }) });
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
  /** The batch brewed under `recipe` through `first`, then a question, and moved to `chosen`. */
  const movedOff = (recipe: string, first: () => void, chosen: string): void => {
    accept({ kind: 'order', batchId, order: { issue: 7 } });
    accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
    first();
    run('ask', { kind: 'needs_input', questions: [which] });
    accept({
      kind: 'recipe',
      batchId,
      recipe: chosen,
      reason: 'a person chose',
      by: 'ann',
      via: 'terminal',
    });
  };
  /** Porter's steps of the batch routed to it, to On tap: its pull request opened on `head`. */
  const porterToOpen = (): void => {
    run('implement', done);
    opened();
  };
  /** The pull request's action of a batch whose last other step ended: On tap, on `head`. */
  const opened = (): void => {
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

  /** The body of the brief posted for the batch, every check on its head finished. */
  const briefBody = async (): Promise<string> => {
    checksFinished();
    const { host, comments } = fakeHost();
    assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
    return comments[0]?.body ?? '';
  };

  /** The brief of a batch that `first` brewed under `reviewed`, then moved to `tasted`. */
  const briefAfterMove = async (first: () => void): Promise<string> => {
    accept({ kind: 'order', batchId, order: { issue: 7 } });
    accept({ kind: 'route', batchId, recipe: 'reviewed', reason: 'label', source: 'label' });
    first();
    const { lane } = log.state().batches.get(batchId) ?? {};
    if (lane?.kind !== 'stuck') run('ask', { kind: 'needs_input', questions: [which] });
    accept({
      kind: 'recipe',
      batchId,
      recipe: 'tasted',
      reason: 'a person chose',
      by: 'ann',
      via: 'terminal',
    });
    run('implement', done);
    run('new-taster', tasted('the cut was not run'));
    opened();
    return briefBody();
  };
  const heldBack = {
    severity: 'major',
    why: 'Breaks the plan',
    introduced: true,
    file: 'plan.md',
  } as const;

  it('never says a skip left open a Taster an earlier recipe blocked, when no one skipped it', async () => {
    const body = await briefAfterMove(() =>
      run('old-taster', {
        kind: 'blocked',
        blockerKind: 'findings',
        summary: 'A change is asked',
        findings: [heldBack],
      }),
    );
    assert.match(body, /- `new-taster`: the cut was not run/);
    assert.doesNotMatch(body, /left open by a skip/);
    assert.doesNotMatch(body, /Breaks the plan/);
  });

  it("leaves out the findings an earlier recipe's Taster left open", async () => {
    const body = await briefAfterMove(() =>
      run('old-taster', {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Tasted',
          assumptions: [],
          verdict: 'approve',
          findings: [{ ...heldBack, severity: 'minor' }],
        },
      }),
    );
    assert.match(body, /\*\*Findings\*\*\nNo finding was recorded\./);
  });

  it("leaves out an earlier recipe's check step from the evidence on this head", async () => {
    const body = await briefAfterMove(() =>
      run('old-taster', done, { readings: [{ result: 'skipped', check: 'lint' }] }),
    );
    assert.match(body, /\*\*Evidence on /);
    assert.doesNotMatch(body, /old-taster/);
  });

  it("leaves out what an earlier recipe's survey proposed", async () => {
    const body = await briefAfterMove(() =>
      run(
        'old-taster',
        { kind: 'succeeded', output: { status: 'done', summary: 'P', map: 'new' } },
        { commit: head },
      ),
    );
    assert.match(body, /\*\*Evidence on /);
    assert.doesNotMatch(body, /The test map of/);
  });

  it("shows the risk the current recipe's Taster left, never an earlier recipe's", async () => {
    movedOff('reviewed', () => run('old-taster', tasted('the plan may be too big')), 'tasted');
    run('implement', done);
    run('new-taster', tasted('the cut was not run'));
    opened();
    const body = await briefBody();
    assert.match(body, /- `new-taster`: the cut was not run/);
    assert.doesNotMatch(body, /the plan may be too big/);
  });

  it("says no Taster tasted a change only an earlier recipe's Taster read", async () => {
    movedOff('reviewed', () => run('old-taster', tasted('the plan may be too big')), 'porter');
    porterToOpen();
    const body = await briefBody();
    assert.match(body, /- No Taster tasted this change\./);
    assert.match(body, /\*\*Risk left\*\*\nNone recorded\./);
  });

  it('posts the brief of a batch that ran a plain step named as a group of its current recipe', async () => {
    movedOff('plain-taste', () => run('taste', tasted('the plan may be too big')), 'group-taste');
    run('implement', done);
    run('one', tasted('the first risk'));
    run('two', tasted('the second risk'));
    opened();
    const body = await briefBody();
    assert.doesNotMatch(body, /`taste`/);
    assert.doesNotMatch(body, /the plan may be too big/);
    assert.match(body, /- `one`: the first risk\n- `two`: the second risk/);
  });

  it("finds the merged-check step of a batch mashed to nip, in nip's own steps: regression test", () => {
    mashed('nip');
    const found = log.state().batches.get(batchId);
    assert.ok(found);
    assert.equal(mergedCheckStep(recipes, loaded.checks, found)?.stepId, 'green');
  });

  it('has the base conflict post of a mashed batch due: regression test', () => {
    onTap();
    const marks = {
      findComment: async () => undefined,
      comment: async () => 1,
    };
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.base_checked',
        batchId,
        pullRequest: url,
        branch: 'main',
        tip: 'b'.repeat(40),
        head,
        conflicts: ['src/a.ts'],
      },
    });
    assert.deepStrictEqual(
      baseConflictEffects({ marks, recipes })
        .due(log.state(), batchId)
        .map(({ effect }) => effect),
      ['base_conflict.1'],
    );
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
