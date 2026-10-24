// The Finer (#455, ADR 0166): a default brewer that simplifies a batch's change and commits it,
// between implement and green. Its out doc lists each change, or says why there was nothing to
// simplify, a done that needs no commit. Played on the fake brewer runner: no model.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attemptLimits } from '../../src/brewers/attempt-plan.ts';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { type Batch, fold } from '../../src/engine/fold.ts';
import { pullRequestKey, pullRequestText, stepReports } from '../../src/engine/pull-request.ts';
import {
  type BreweryFiles,
  type LoadedRecipes,
  loadRecipes,
} from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Git } from '../../src/workspace/git.ts';
import { recipeText } from '../helpers/brewery-files.ts';
import { createBrewing, defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner, outDoc } from '../helpers/fake-brewer-runner.ts';

// A Brewery with no files of its own: the Finer, Nip and its brewers come from Foedrum's defaults.
const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));
const withRecipe = (name: string, steps: readonly unknown[]): BreweryFiles => ({
  ...noFiles,
  recipes: [{ path: `recipes/${name}.jsonc`, text: recipeText(name, steps, { testFirst: false }) }],
});
const valid = (result: LoadedRecipes) => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

const room = withRecipe('amber', [
  { id: 'implement', brewer: 'cellarman' },
  { id: 'fine', brewer: 'finer' },
  { action: 'openPullRequest' },
]);

/** A Finer's attempt that ends done with its own fields, and `commits` commits. */
const fined = (fields: Record<string, unknown>, commits: number): Behaviour => ({
  kind: 'settle',
  facts: {
    exit: { kind: 'exited', code: 0 },
    outDoc: outDoc({ status: 'done', summary: 'Fined', ...fields }),
    denials: 0,
    deniedTools: [],
    turns: 12,
    commits: { kind: 'counted', count: commits },
  },
});

const start = 'c'.repeat(40);

/** Brews `room` on the fake runner, each step's limits from its brewer, its worktree at `start`. */
const brew = async (scripts: Record<string, Behaviour[]>): Promise<Batch> => {
  const store = openSqliteEventStore(':memory:');
  try {
    const { recipes, brewers } = valid(loadRecipes(room));
    const brewing = createBrewing({
      store,
      runner: fakeBrewerRunner(scripts),
      recipes,
      limits: (stepId) => {
        const found = brewers.find('amber', stepId);
        return found === undefined ? defaultLimits : attemptLimits(found.brewer, start);
      },
      clock: () => new Date('2026-10-24T12:00:00.000Z'),
    });
    assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
    // The ledger has the pull request the fake runner's action opened (ADR 0071).
    store.withTransaction((tx) => {
      tx.append({
        type: 'effect.applied',
        key: effectKey.encode(pullRequestKey('b1')),
        result: 'https://github.com/acme/brewery/pull/2',
      });
    });
    assert.ok(
      brewing.command({
        kind: 'route',
        batchId: 'b1',
        recipe: 'amber',
        reason: 'label',
        source: 'label',
      }),
    );
    await brewing.drive();
    const batch = fold(brewing.events()).batches.get('b1');
    assert.ok(batch !== undefined);
    return batch;
  } finally {
    store.close();
  }
};

const duplicate = {
  file: 'src/slug.ts',
  line: 4,
  why: 'slugOf repeated toSlug in src/text.ts:12; it now calls it',
};

describe('the default Finer (defaults/brewers/finer.md)', () => {
  it('commits on the builder alias, with the fining schema, and keeps the red proof tests', () => {
    const found = valid(loadRecipes(room)).brewers.find('amber', 'fine');
    assert.ok(found !== undefined, 'the recipe has no fine step');
    const { brewer } = found;
    assert.equal(brewer.name, 'finer');
    assert.equal(brewer.model, 'builder');
    assert.equal(brewer.produces, 'commits');
    assert.equal(brewer.access, 'write');
    assert.equal(brewer.output.schema, 'fining');
    assert.deepEqual(brewer.git, { commit: true });
    for (const guard of ['requiresOutDoc', 'requiresCommits', 'testsUnchanged']) {
      assert.ok(brewer.guards.includes(guard as never), `${guard}: ${brewer.guards.join(', ')}`);
    }
  });

  it('says what to look for and what it may change, in the sections the review skill reads', () => {
    const found = valid(loadRecipes(room)).brewers.find('amber', 'fine');
    assert.ok(found !== undefined);
    const headings = found.instructions.split('\n').filter((line) => line.startsWith('## '));
    assert.ok(headings.includes('## What to look for'), headings.join(', '));
    assert.ok(headings.includes('## What you may change'), headings.join(', '));
  });

  it('holds the change the engine read with git in its prompt, as a Taster that reviews a diff', async () => {
    const ref = { batchId: '12-1', stepId: 'fine', attempt: 1 };
    const worktree = (name: string, commit: string) => ({
      repo: 'acme/api',
      path: join('/work', name),
      branch: `foedrum/12-1/${name}`,
      commit,
    });
    const events: Event[] = [
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-10-24T13:00:00.000Z',
      },
      {
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'amber',
        reason: 'label',
        source: 'label',
      },
      {
        type: 'step.scheduled',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        deadlineAt: '2026-10-24T13:00:00.000Z',
      },
      {
        type: 'step.started',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        worktree: worktree('implement-1', start),
      },
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        outcome: {
          kind: 'succeeded',
          output: { status: 'done', summary: 'Done', assumptions: [] },
        },
      },
      { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-24T13:00:00.000Z' },
      {
        type: 'step.started',
        ...ref,
        session: { id: '0f8fad5b-d9cb-469f-a165-70867728950e', worktree: join('/work', 'fine-1') },
        worktree: worktree('fine-1', 'b'.repeat(40)),
      },
    ];
    const git: Git = async (_cwd, args) => ({
      code: 0,
      stdout: args[0] === 'log' ? 'f00dfee Add slugOf\n' : 'diff --git a/src/slug.ts\n',
      stderr: '',
    });
    const plans = createAttemptPlans({
      state: () => fold(events),
      brewers: valid(loadRecipes(room)).brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Add a slug helper.',
      git,
      files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const { prompt } = await plans.plan({ ref, limits: plans.limits(ref) });
    assert.ok(
      prompt.includes(`source="the change since commit ${start}" name="change">\nThe commits`),
      'the prompt does not hold the change as an input',
    );
    assert.match(prompt, /f00dfee Add slugOf/);
  });
});

describe('a batch through the Finer (ADR 0166)', () => {
  it('goes on to the pull request when the Finer had nothing to simplify, with no commit', async () => {
    const batch = await brew({
      implement: [behave.succeed()],
      fine: [fined({ unchanged: 'The change is already as small as it does' }, 0)],
      'open-pull-request': [behave.succeed()],
    });
    assert.equal(batch.lane.kind, 'on_tap', JSON.stringify(batch.lane));
    const text = renderStatus(batch, ['implement', 'fine', 'open-pull-request']);
    const lines = text.split('\n');
    const at = lines.indexOf('**Simplifications**');
    assert.ok(at >= 0, text);
    assert.equal(
      lines[at + 1],
      '- `fine`: nothing to simplify: The change is already as small as it does',
    );
  });

  it("lists the Finer's changes in the status comment and the pull request's step reports", async () => {
    const batch = await brew({
      implement: [behave.succeed()],
      fine: [fined({ changes: [duplicate, { file: 'src/a.ts', why: 'Dropped a wrapper' }] }, 1)],
      'open-pull-request': [behave.succeed()],
    });
    const lines = renderStatus(batch, ['implement', 'fine', 'open-pull-request']).split('\n');
    const at = lines.indexOf('**Simplifications**');
    assert.deepEqual(lines.slice(at + 1, at + 3), [
      '- `fine`: src/slug.ts:4: slugOf repeated toSlug in src/text.ts:12; it now calls it',
      '- `fine`: src/a.ts: Dropped a wrapper',
    ]);
    const { body } = pullRequestText({
      title: 'Add a slug helper',
      closes: { repo: 'acme/brewery', issue: 1 },
      reports: stepReports(batch),
    });
    const reported = body.split('\n');
    const from = reported.indexOf('fine: Fined');
    assert.deepEqual(reported.slice(from, from + 3), [
      'fine: Fined',
      '  simplified: src/slug.ts:4: slugOf repeated toSlug in src/text.ts:12; it now calls it',
      '  simplified: src/a.ts: Dropped a wrapper',
    ]);
  });

  it('makes the batch Stuck on a divergence when the Finer lists changes but committed none', async () => {
    const batch = await brew({
      implement: [behave.succeed()],
      fine: [fined({ changes: [duplicate] }, 0)],
    });
    assert.equal(batch.lane.kind, 'stuck');
    assert.match(JSON.stringify(batch.lane), /made no commit since cccccc/);
  });
});
