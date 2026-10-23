// Tasting through lenses (#26, ADR 0017, ADR 0161): a recipe's lens step runs the default Taster
// with the lens's text as an input, and its findings reach the pull request and the status
// comment. Advisory by default; with "blocking": true a changes verdict sends the batch back along
// the step's onBlocked route, then makes it Stuck. Played on the fake brewer runner: no model.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attemptLimits, routeInput, routeOf } from '../../src/brewers/attempt-plan.ts';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import type { PromptInput } from '../../src/brewers/prompt.ts';
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
import { recipeText } from '../helpers/brewery-files.ts';
import { createBrewing, defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner, outDoc } from '../helpers/fake-brewer-runner.ts';

// A Brewery with no files of its own but one recipe: the Taster, Cellarman and the five lenses
// come from Foedrum's defaults.
const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));
const withRecipe = (name: string, steps: readonly unknown[]): BreweryFiles => ({
  ...noFiles,
  recipes: [{ path: `recipes/${name}.jsonc`, text: recipeText(name, steps, { testFirst: false }) }],
});

const valid = (result: LoadedRecipes) => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

const PULL_REQUEST = 'https://github.com/acme/brewery/pull/2';

const LENSES = ['correctness', 'security', 'cross-platform', 'design-conformance', 'test-design'];

/**
 * The tasting room's pull request: one planted defect per lens, from the planted-defect sample
 * (test/fixtures/brew-review/planted-demo), as each lens's Taster reports it.
 */
const PLANTED: Readonly<Record<string, Record<string, unknown>>> = {
  correctness: {
    file: 'src/engine/wait-for-merge.ts',
    line: 13,
    severity: 'blocker',
    why: 'waitForMerge polls isMerged with no deadline, so a pull request never merged hangs it',
    introduced: true,
  },
  security: {
    file: 'src/engine/wait-for-merge.ts',
    line: 20,
    severity: 'major',
    why: 'the Brewery name is not checked, so ../ in it leaves ~/.foedrum',
    introduced: true,
  },
  'cross-platform': {
    file: 'src/engine/wait-for-merge.ts',
    line: 20,
    severity: 'blocker',
    why: "the path is built as homedir() + '/.foedrum/', with mixed separators on Windows",
    introduced: true,
  },
  'design-conformance': {
    file: 'src/workspace/current-branch.ts',
    line: 5,
    severity: 'blocker',
    why: 'git runs through execFileSync, not the process runner in src/platform/processes.ts',
    introduced: true,
  },
  'test-design': {
    file: 'test/unit/brewery-name.test.ts',
    line: 6,
    severity: 'major',
    why: 'every test passes against a stub that rejects every name: none accepts a valid one',
    introduced: true,
  },
};

/** A Taster's attempt that ends done with `verdict` and `findings`. */
const tasted = (verdict: string, findings: readonly unknown[], summary = 'Tasted'): Behaviour => {
  const { facts } = behave.succeed() as Extract<Behaviour, { kind: 'settle' }>;
  return {
    kind: 'settle',
    facts: { ...facts, outDoc: outDoc({ status: 'done', summary, verdict, findings }) },
  };
};

/** Brews `recipe` from `files` on the fake runner, with each step's limits from its brewer. */
const brew = async (
  files: BreweryFiles,
  recipe: string,
  scripts: (attempt: { stepId: string }) => Behaviour | undefined,
  seen?: (batch: Batch, attempt: { batchId: string; stepId: string; attempt: number }) => void,
): Promise<{ events: Event[]; batch: Batch }> => {
  const store = openSqliteEventStore(':memory:');
  try {
    const { recipes, brewers } = valid(loadRecipes(files));
    const brewing = createBrewing({
      store,
      runner: fakeBrewerRunner(({ ref }) => {
        const batch = fold(brewing.events()).batches.get(ref.batchId);
        if (batch !== undefined) seen?.(batch, ref);
        return scripts(ref);
      }),
      recipes,
      limits: (stepId) => {
        const found = brewers.find(recipe, stepId);
        return found === undefined
          ? defaultLimits
          : attemptLimits(found.brewer, undefined, found.blocking);
      },
      clock: () => new Date('2026-10-23T12:00:00.000Z'),
    });
    assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
    // The fake runner plays the openPullRequest action; the ledger has the pull request it opened,
    // as the driver records it, without which decide keeps the batch from going on tap (ADR 0071).
    store.withTransaction((tx) => {
      tx.append({
        type: 'effect.applied',
        key: effectKey.encode(pullRequestKey('b1')),
        result: PULL_REQUEST,
      });
    });
    assert.ok(
      brewing.command({ kind: 'route', batchId: 'b1', recipe, reason: 'label', source: 'label' }),
    );
    await brewing.drive();
    const events = brewing.events();
    const batch = fold(events).batches.get('b1');
    assert.ok(batch !== undefined);
    return { events, batch };
  } finally {
    store.close();
  }
};

const startedSteps = (events: readonly Event[]): string[] =>
  events.flatMap((event) => (event.type === 'step.started' ? [event.stepId] : []));

describe('the tasting room: one lens step per lens, one after another (#26)', () => {
  const room = withRecipe('tasting-room', [
    { id: 'implement', brewer: 'cellarman' },
    ...LENSES.map((lens) => ({ id: lens, brewer: 'taster', lens: `diff/${lens}` })),
    { action: 'openPullRequest' },
  ]);

  it("reports each planted defect from its own Taster's attempt, and still reaches the pull request", async () => {
    const { events, batch } = await brew(room, 'tasting-room', ({ stepId }) =>
      stepId in PLANTED
        ? tasted('changes', [PLANTED[stepId]], `One finding through diff/${stepId}`)
        : behave.succeed(),
    );
    assert.deepEqual(startedSteps(events), ['implement', ...LENSES, 'open-pull-request']);
    assert.deepEqual(batch.lane, { kind: 'on_tap', pullRequests: [PULL_REQUEST] });

    const reports = stepReports(batch);
    for (const lens of LENSES) {
      const report = reports.find(({ stepId }) => stepId === lens);
      assert.deepEqual(report?.tasting, { verdict: 'changes', findings: [PLANTED[lens]] });
    }
    const { body } = pullRequestText({
      title: 'Wait for a bottle to be merged',
      closes: { repo: 'acme/brewery', issue: 1 },
      reports,
    });
    for (const lens of LENSES) {
      const { file, line, severity, why } = PLANTED[lens] ?? {};
      assert.ok(
        body.includes(
          `${lens}: One finding through diff/${lens}\n  verdict: changes\n  finding: ${severity} in ${file}:${line}: ${why}`,
        ),
        body,
      );
    }
    const status = renderStatus(
      batch,
      valid(loadRecipes(room)).recipes.find('tasting-room')?.steps,
    );
    assert.ok(status.includes('**Findings**'), status);
    for (const lens of LENSES) assert.ok(status.includes(`- \`${lens}\`: `), status);
  });
});

describe('a blocking lens step (#26, ADR 0161)', () => {
  const blocking = withRecipe('stout', [
    { id: 'implement', brewer: 'cellarman' },
    {
      id: 'correctness',
      brewer: 'taster',
      lens: 'diff/correctness',
      blocking: true,
      onBlocked: { findings: { goto: 'implement', maxRounds: 1 } },
    },
    { action: 'openPullRequest' },
  ]);

  it('sends a changes verdict back to Cellarman once, with what the Taster said, then makes the batch Stuck', async () => {
    const told: (PromptInput | undefined)[] = [];
    const { brewers } = valid(loadRecipes(blocking));
    const { events, batch } = await brew(
      blocking,
      'stout',
      ({ stepId }) =>
        stepId === 'correctness'
          ? tasted('changes', [PLANTED.correctness], 'The poll has no deadline')
          : behave.succeed(),
      (seen, ref) => {
        if (ref.stepId !== 'implement') return;
        const route = routeOf(seen, ref, (id) => brewers.find('stout', id)?.brewer.output.doc);
        told.push(route === undefined ? undefined : routeInput(route));
      },
    );
    assert.deepEqual(startedSteps(events), [
      'implement',
      'correctness',
      'implement',
      'correctness',
    ]);
    assert.deepEqual(batch.lane.kind === 'stuck' && batch.lane.reason, {
      kind: 'blocked',
      stepId: 'correctness',
      blockerKind: 'findings',
      summary: 'the Taster asks for changes: The poll has no deadline',
    });
    assert.equal(told[0], undefined);
    assert.deepEqual(told[1]?.source, {
      kind: 'route',
      step: 'implement',
      from: 'correctness',
      why: 'findings',
    });
    assert.match(told[1]?.text ?? '', /the Taster asks for changes: The poll has no deadline/);
  });

  it('goes on to the pull request when the Taster approves', async () => {
    const { events, batch } = await brew(blocking, 'stout', ({ stepId }) =>
      stepId === 'correctness' ? tasted('approve', []) : behave.succeed(),
    );
    assert.deepEqual(startedSteps(events), ['implement', 'correctness', 'open-pull-request']);
    assert.deepEqual(batch.lane, { kind: 'on_tap', pullRequests: [PULL_REQUEST] });
  });
});

describe('the default Taster (defaults/brewers/taster.md)', () => {
  const room = withRecipe('amber', [
    { id: 'implement', brewer: 'cellarman' },
    { id: 'correctness', brewer: 'taster', lens: 'diff/correctness' },
    { action: 'openPullRequest' },
  ]);

  it('is read-only: it reports, commits nothing and has no tool that writes a file', () => {
    const found = valid(loadRecipes(room)).brewers.find('amber', 'correctness');
    assert.ok(found !== undefined);
    const { brewer } = found;
    assert.equal(brewer.access, 'read');
    assert.equal(brewer.produces, 'report');
    assert.equal(brewer.output.schema, 'tasting');
    for (const tool of brewer.tools.allow) assert.doesNotMatch(tool, /^(Edit|Write|NotebookEdit)/);
  });

  it("holds its step's lens and the change to review in its prompt, as inputs", async () => {
    const lens = readFileSync(join(FOEDRUM_DEFAULTS, 'lenses', 'diff', 'correctness.md'), 'utf8');
    const base = 'a'.repeat(40);
    const worktree = (name: string, commit: string) => ({
      repo: 'acme/api',
      path: join('/work', name),
      branch: `foedrum/12-1/${name}`,
      commit,
    });
    const ref = { batchId: '12-1', stepId: 'correctness', attempt: 1 };
    const events: Event[] = [
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-10-23T13:00:00.000Z',
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
        deadlineAt: '2026-10-23T13:00:00.000Z',
      },
      {
        type: 'step.started',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        worktree: worktree('implement-1', base),
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
      { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-23T13:00:00.000Z' },
      {
        type: 'step.started',
        ...ref,
        session: {
          id: '0f8fad5b-d9cb-469f-a165-70867728950e',
          worktree: join('/work', 'correctness-1'),
        },
        worktree: worktree('correctness-1', 'b'.repeat(40)),
      },
    ];
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
      orderText: async () => 'Wait for a bottle to be merged.',
      files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const { prompt } = await plans.plan({ ref, limits: plans.limits(ref) });
    assert.ok(
      prompt.includes(
        `source="lens diff/correctness, file defaults/lenses/diff/correctness.md" name="lens">\n${lens}\n</`,
      ),
      'the prompt does not hold the lens as an input',
    );
    assert.match(
      prompt,
      new RegExp(
        `source="the change since commit ${base}" name="change">\\n.*git diff ${base} HEAD`,
      ),
    );
  });
});
