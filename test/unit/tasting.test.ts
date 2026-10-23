// Tasting through lenses (#26, ADR 0017, ADR 0161): a recipe's lens step runs the default Taster
// with the lens's text as an input, and its findings reach the pull request and the status
// comment. Advisory by default; with "blocking": true a changes verdict sends the batch back along
// the step's onBlocked route, then makes it Stuck. Played on the fake brewer runner: no model.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { devNull } from 'node:os';
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
import { TastingOutDoc } from '../../src/schemas/out-doc.ts';
import type { Git } from '../../src/workspace/git.ts';
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

  it('is read-only: it reports, commits nothing, runs no shell and writes only its out doc', () => {
    const found = valid(loadRecipes(room)).brewers.find('amber', 'correctness');
    assert.ok(found !== undefined);
    const { brewer } = found;
    assert.equal(brewer.access, 'read');
    assert.equal(brewer.produces, 'report');
    assert.equal(brewer.output.schema, 'tasting');
    // No Bash: git diff --output and --no-index reach any file outside a sandbox (ADR 0161).
    assert.deepEqual(brewer.tools.allow, ['Read', 'Grep', 'Glob', `Edit(${brewer.output.doc})`]);
  });

  const base = 'a'.repeat(40);
  const ref = { batchId: '12-1', stepId: 'correctness', attempt: 1 };
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
  /** The Taster's prompt, planned with `git` answering the change, and the git calls it made. */
  const planTaster = async (git: Git, files: BreweryFiles = room, more: readonly Event[] = []) => {
    const calls: { cwd: string; args: readonly string[]; config: unknown }[] = [];
    const plans = createAttemptPlans({
      // `more` happens before the Taster is scheduled.
      state: () => fold([...events.slice(0, -2), ...more, ...events.slice(-2)]),
      brewers: valid(loadRecipes(files)).brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Wait for a bottle to be merged.',
      git: (cwd, args, options) => {
        calls.push({ cwd, args, config: options?.config });
        return git(cwd, args, options);
      },
      files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    return {
      plan: plans.plan({ ref, limits: plans.limits(ref) }),
      calls,
      limits: plans.limits(ref),
    };
  };
  const LOG = 'f00dfee Wait for a bottle to be merged';
  const DIFF = 'diff --git a/src/wait.ts b/src/wait.ts\n+  while (!(await isMerged())) {}';
  const answers: Git = async (_cwd, args) => ({
    code: 0,
    stdout: args[0] === 'log' ? `${LOG}\n` : `${DIFF}\n`,
    stderr: '',
  });

  it("holds its step's lens, and the change the engine read with git, in its prompt as inputs", async () => {
    const lens = readFileSync(join(FOEDRUM_DEFAULTS, 'lenses', 'diff', 'correctness.md'), 'utf8');
    const { plan, calls } = await planTaster(answers);
    const { prompt } = await plan;
    assert.ok(
      prompt.includes(
        `source="lens diff/correctness, file defaults/lenses/diff/correctness.md" name="lens">\n${lens}\n</`,
      ),
      'the prompt does not hold the lens as an input',
    );
    assert.ok(
      prompt.includes(`source="the change since commit ${base}" name="change">\n`),
      'the prompt does not hold the change as an input',
    );
    const change = prompt.slice(prompt.indexOf('name="change">'));
    assert.ok(change.includes(LOG) && change.includes(DIFF), change.slice(0, 400));
    // In the clone, never by discovery in the worktree, with no hook, external diff or textconv a
    // brewer could have planted (ADR 0029, ADR 0096): from the commit the batch started at to the
    // commit the Taster's worktree started at.
    const head = 'b'.repeat(40);
    const inClone = { 'core.hooksPath': devNull, 'core.fsmonitor': 'false' };
    assert.deepEqual(calls, [
      {
        cwd: join('/clones', 'acme/api'),
        // The batch's own line: no commit a merge of the base brought in (ADR 0164).
        args: [
          'log',
          '--no-show-signature',
          '--first-parent',
          '--format=%h %s',
          `${base}..${head}`,
        ],
        config: inClone,
      },
      {
        cwd: join('/clones', 'acme/api'),
        args: [
          '-c',
          'core.quotePath=false',
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          base,
          head,
        ],
        config: inClone,
      },
    ]);
  });

  it("reviews only the batch's own change after a merge of the base, from the base it merged (ADR 0164)", async () => {
    const merged = 'c'.repeat(40);
    const head = 'b'.repeat(40);
    // The green check merged the base, at `merged`, into the task tree the Taster starts at.
    const green = { batchId: '12-1', stepId: 'green', attempt: 1 };
    const checked: Event[] = [
      { type: 'step.scheduled', ...green, deadlineAt: '2026-10-23T13:00:00.000Z' },
      { type: 'step.started', ...green, worktree: worktree('green-1', base) },
      {
        type: 'effect.applied',
        key: '["12-1","green",1,"merge_base"]',
        result: { base: merged, merged: head },
      },
      {
        type: 'step.finished',
        ...green,
        outcome: {
          kind: 'succeeded',
          output: { status: 'done', summary: 'Green', assumptions: [] },
        },
      },
    ];
    const { plan, calls } = await planTaster(answers, room, checked);
    const { prompt } = await plan;
    assert.ok(
      prompt.includes(`source="the change since commit ${merged}" name="change">`),
      'the change does not start at the merged base',
    );
    assert.deepEqual(
      calls.map(({ args }) =>
        args.filter((arg) => arg.includes('..') || /^[0-9a-f]{40}$/.test(arg)),
      ),
      [[`${merged}..${head}`], [merged, head]],
    );
  });

  it('cuts a change longer than 256 KiB, saying so', async () => {
    const long: Git = async (_cwd, args) => ({
      code: 0,
      stdout: args[0] === 'log' ? `${LOG}\n` : `${DIFF}\n${'+x\n'.repeat(200_000)}`,
      stderr: '',
    });
    const { plan } = await planTaster(long);
    const { prompt } = await plan;
    const start = prompt.indexOf('name="change">\n') + 'name="change">\n'.length;
    const change = prompt.slice(start, prompt.indexOf('\n</untrusted-input', start));
    assert.ok(Buffer.byteLength(change, 'utf8') <= 256 * 1024, `${change.length} characters`);
    assert.match(change, /\[cut: the rest is past the change input's limit of 262144 bytes\]$/);
  });

  it('gives a Taster that reviews a plan no change, and reads none', async () => {
    const planned: BreweryFiles = {
      ...withRecipe('amber', [
        { id: 'correctness', brewer: 'taster', lens: 'plan/coverage' },
        { id: 'implement', brewer: 'cellarman' },
        { action: 'openPullRequest' },
      ]),
      lenses: [{ path: 'lenses/plan/coverage.md', text: 'Look at what the plan covers.' }],
    };
    const { plan, calls } = await planTaster(answers, planned);
    const { prompt } = await plan;
    assert.match(
      prompt,
      /source="lens plan\/coverage, file lenses\/plan\/coverage\.md" name="lens">/,
    );
    assert.doesNotMatch(prompt, /name="change"/);
    assert.deepEqual(calls, []);
  });

  it("gives the runner a Taster's schema, and blocking only on a blocking step", async () => {
    const blocking = withRecipe('amber', [
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
    for (const [files, expected] of [
      [blocking, { blocking: true }],
      [room, {}],
    ] as const) {
      const { outDoc, ...rest } = (await planTaster(answers, files)).limits;
      assert.equal(outDoc.file, 'taste.md');
      assert.equal(outDoc.schema, TastingOutDoc);
      assert.deepEqual(rest, { maxTurns: 60, ...expected });
    }
  });

  it('keeps the start of a change git was stopped for, past its output limit, and cuts it', async () => {
    // As the runner answers when it kills git for its output (ADR 0035).
    const stopped: Git = async (_cwd, args) =>
      args[0] === 'log'
        ? { code: 0, stdout: `${LOG}\n`, stderr: '' }
        : {
            code: null,
            stdout: `${DIFF}\n${'+x\n'.repeat(200_000)}`,
            stderr: 'git output passed 524288 bytes',
            killed: 'too-much-output',
          };
    const { prompt } = await (await planTaster(stopped)).plan;
    assert.match(prompt, /\[cut: the rest is past the change input's limit of 262144 bytes\]/);
  });

  it('fails the plan when git timed out reading the change', async () => {
    const late: Git = async () => ({
      code: null,
      stdout: '',
      stderr: 'git timed out after 60000 ms',
      killed: 'timed-out',
    });
    const { plan } = await planTaster(late);
    await assert.rejects(plan, /was not read: git log .* exited with code null: git timed out/);
  });

  it('fails the plan, naming the git call, when git cannot read the change', async () => {
    const broken: Git = async () => ({ code: 128, stdout: '', stderr: 'fatal: bad object' });
    const { plan } = await planTaster(broken);
    await assert.rejects(
      plan,
      /the change since commit a{40} was not read: git log .* exited with code 128: fatal: bad object/,
    );
  });
});
