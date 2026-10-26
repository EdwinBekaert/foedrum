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
import { MAX_RISK_LEFT, MOST_RISKS_LEFT, TastingOutDoc } from '../../src/schemas/out-doc.ts';
import type { Git } from '../../src/workspace/git.ts';
import { recipeText } from '../helpers/brewery-files.ts';
import { createBrewing, defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner, outDoc } from '../helpers/fake-brewer-runner.ts';

// A Brewery with no files of its own but one recipe: the Taster, Cellarman and the default lenses
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
          : attemptLimits(found.brewer, undefined, found.blocking, found.together);
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

  it('sends a changes verdict back to Cellarman once, with what the Taster said, then makes the batch Stuck with the open findings (ADR 0192)', async () => {
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
      roundsOut: { rounds: 1, open: [PLANTED.correctness], more: 0 },
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

  it("asks in its Out doc section for the risk left, in the lens's terms, and for nothing when there is none (ADR 0214)", () => {
    const found = valid(loadRecipes(room)).brewers.find('amber', 'correctness');
    assert.ok(found !== undefined);
    const section = found.instructions.slice(found.instructions.indexOf('## Out doc'));
    assert.match(section, /- `"riskLeft"`: /);
    assert.match(section, /in the terms of your lens/);
    assert.match(section, /could not verify/);
    assert.match(section, /not a finding/);
    assert.match(section, /nothing to say, leave it out/);
  });

  it('gives the Taster the bounds of riskLeft its schema holds it to (ADR 0214)', () => {
    const found = valid(loadRecipes(room)).brewers.find('amber', 'correctness');
    assert.ok(found !== undefined);
    assert.ok(
      found.instructions.includes(
        `at most ${MOST_RISKS_LEFT} lines of at most ${MAX_RISK_LEFT} characters each`,
      ),
      found.instructions,
    );
    assert.deepEqual([MOST_RISKS_LEFT, MAX_RISK_LEFT], [10, 300]);
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

  it('lists the regression tests a step of the batch named in its change, before the diff (ADR 0170)', async () => {
    const gauge = { batchId: '12-1', stepId: 'gauge', attempt: 1 };
    const output = {
      status: 'done',
      summary: 'Tests for waitForMerge',
      assumptions: [],
      tests: ['gives up at the deadline'],
      regressionTests: ['returns once merged', 'polls every second'],
    };
    const gauged: Event[] = [
      { type: 'step.scheduled', ...gauge, deadlineAt: '2026-10-23T13:00:00.000Z' },
      { type: 'step.started', ...gauge, worktree: worktree('gauge-1', base) },
      { type: 'step.finished', ...gauge, outcome: { kind: 'succeeded', output } },
    ];
    const { plan } = await planTaster(answers, room, gauged);
    const { prompt } = await plan;
    const list = [
      'The tests step gauge named as regression tests, which pass before the change:',
      '- returns once merged',
      '- polls every second',
    ].join('\n');
    assert.ok(prompt.includes(`${LOG}\n\n${list}\n\nTheir diff:\n`), prompt);
  });

  it('lists no regression tests when no step named any, and each name on one line (ADR 0170)', async () => {
    const { plan } = await planTaster(answers);
    assert.ok((await plan).prompt.includes(`${LOG}\n\nTheir diff:\n`));
    const gauge = { batchId: '12-1', stepId: 'gauge', attempt: 1 };
    const output = {
      status: 'done',
      summary: 'Tests',
      assumptions: [],
      regressionTests: ['returns\n  once merged'],
    };
    const named = await planTaster(answers, room, [
      { type: 'step.scheduled', ...gauge, deadlineAt: '2026-10-23T13:00:00.000Z' },
      { type: 'step.started', ...gauge, worktree: worktree('gauge-1', base) },
      { type: 'step.finished', ...gauge, outcome: { kind: 'succeeded', output } },
    ]);
    assert.match((await named.plan).prompt, /\n- returns once merged\n\nTheir diff:\n/);
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
      // A Taster's out doc, read with its findings and verdict.
      const done = { status: 'done', summary: 'Tasted', verdict: 'approve' };
      assert.deepEqual(outDoc.schema.safeParse(done).data, TastingOutDoc.parse(done));
      assert.equal(outDoc.schema.safeParse({ ...done, verdict: 'changes' }).success, false);
      assert.deepEqual(rest, { maxTurns: 60, ...expected });
    }
  });

  describe('a step of several lenses together (#560, ADR 0220)', () => {
    const together = withRecipe('amber', [
      { id: 'implement', brewer: 'cellarman' },
      { id: 'correctness', brewer: 'taster', lenses: ['diff/acceptance', 'diff/correctness'] },
      { action: 'openPullRequest' },
    ]);
    const lensText = (name: string) =>
      readFileSync(join(FOEDRUM_DEFAULTS, 'lenses', 'diff', `${name}.md`), 'utf8');

    it("holds every lens file once, in the step's order, as its one input lens, and the change once", async () => {
      const { prompt } = await (await planTaster(answers, together)).plan;
      const source =
        'lenses diff/acceptance (file defaults/lenses/diff/acceptance.md), diff/correctness (file defaults/lenses/diff/correctness.md)';
      const start = prompt.indexOf(`source="${source}" name="lens">\n`);
      assert.ok(start >= 0, prompt.slice(prompt.indexOf('## Untrusted input')));
      const input = prompt.slice(start, prompt.indexOf('\n</untrusted-input', start));
      const acceptance = input.indexOf(lensText('acceptance'));
      const correctness = input.indexOf(lensText('correctness'));
      assert.ok(acceptance > 0 && correctness > acceptance, input.slice(0, 400));
      assert.equal(prompt.split(lensText('correctness')).length, 2, 'a lens file twice');
      assert.equal(prompt.split('name="lens">').length, 2, 'more than one lens input');
      assert.equal(prompt.split('name="change">').length, 2, 'the change not once');
    });

    it("tells the Taster to review through each lens in turn and name each finding's lens", async () => {
      const { prompt } = await (await planTaster(answers, together)).plan;
      const text = prompt.slice(prompt.indexOf('## Several lenses together'));
      assert.ok(text.length < prompt.length, 'no text for lenses together');
      assert.match(text, /diff\/acceptance, diff\/correctness/);
      assert.match(text, /through each lens in turn/);
      assert.match(text, /"lens"/);
      assert.match(text, /report under each lens only what it asks/);
      assert.match(text, /Start each item of `riskLeft` with its lens/);
      // Before the out doc contract, as the engine's other fixed texts are.
      assert.ok(text.indexOf('When you finish, write taste.md') > 0);
    });

    it("holds a one-lens step's finding that names a lens to the step's lens (review of #571)", async () => {
      const { outDoc } = (await planTaster(answers)).limits;
      const finding = { file: 'src/a.ts', severity: 'minor', why: 'x', introduced: true };
      const doc = (findings: readonly unknown[]) => ({
        status: 'done',
        summary: 'Tasted',
        verdict: 'approve',
        findings,
      });
      assert.equal(outDoc.schema.safeParse(doc([finding])).success, true);
      const own = doc([{ ...finding, lens: 'diff/correctness' }]);
      assert.equal(outDoc.schema.safeParse(own).success, true);
      const other = outDoc.schema.safeParse(doc([{ ...finding, lens: 'diff/security' }]));
      assert.deepEqual(
        other.error?.issues.map(({ path, message }) => ({ path, message })),
        [
          {
            path: ['findings', 0, 'lens'],
            message: "Must be the step's lens, diff/correctness, or left out",
          },
        ],
      );
    });

    it('gives a one-lens step no text for lenses together', async () => {
      const { prompt } = await (await planTaster(answers)).plan;
      assert.doesNotMatch(prompt, /Several lenses together/);
    });

    it("gives the runner a schema that holds each finding to the step's lenses", async () => {
      const { outDoc } = (await planTaster(answers, together)).limits;
      const finding = { file: 'src/a.ts', severity: 'minor', why: 'x', introduced: true };
      const doc = (findings: readonly unknown[]) => ({
        status: 'done',
        summary: 'Tasted',
        verdict: 'approve',
        findings,
      });
      assert.equal(
        outDoc.schema.safeParse(doc([{ ...finding, lens: 'diff/acceptance' }])).success,
        true,
      );
      assert.equal(outDoc.schema.safeParse(doc([finding])).success, false);
      assert.equal(
        outDoc.schema.safeParse(doc([{ ...finding, lens: 'diff/security' }])).success,
        false,
      );
    });
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

describe('the tasting room in one parallel group (#428, ADR 0168)', () => {
  const room = withRecipe('tasting-room', [
    { id: 'implement', brewer: 'cellarman' },
    {
      id: 'tasting',
      parallel: LENSES.map((lens) => ({ id: lens, brewer: 'taster', lens: `diff/${lens}` })),
    },
    { action: 'openPullRequest' },
  ]);
  const planted = ({ stepId }: { stepId: string }): Behaviour =>
    stepId in PLANTED
      ? tasted('changes', [PLANTED[stepId]], `One finding through diff/${stepId}`)
      : behave.succeed();

  it('reports each planted defect from its own attempt, all of them started before any ended', async () => {
    const { events, batch } = await brew(room, 'tasting-room', planted);
    const at = (type: Event['type']) =>
      events.flatMap((event, index) =>
        event.type === type && 'stepId' in event && LENSES.includes(event.stepId) ? [index] : [],
      );
    assert.equal(at('step.started').length, LENSES.length);
    assert.ok(Math.max(...at('step.started')) < Math.min(...at('step.finished')), 'they overlap');
    assert.deepEqual(batch.lane, { kind: 'on_tap', pullRequests: [PULL_REQUEST] });
    const reports = stepReports(batch);
    for (const lens of LENSES) {
      const report = reports.find(({ stepId }) => stepId === lens);
      assert.deepEqual(report?.tasting, { verdict: 'changes', findings: [PLANTED[lens]] });
    }
    const status = renderStatus(
      batch,
      valid(loadRecipes(room)).recipes.find('tasting-room')?.steps,
    );
    for (const lens of LENSES) assert.ok(status.includes(`- \`${lens}\`: `), status);
  });

  it("keeps each lens's risk left with its own step (ADR 0214)", async () => {
    const risks: Readonly<Record<string, string>> = {
      correctness: 'The retry path only shows in a run',
      security: 'Could not read the vendored parser',
    };
    const { batch } = await brew(room, 'tasting-room', ({ stepId }) => {
      if (!LENSES.includes(stepId)) return behave.succeed();
      const { facts } = behave.succeed() as Extract<Behaviour, { kind: 'settle' }>;
      const riskLeft = stepId in risks ? [risks[stepId]] : [];
      const doc = { status: 'done', summary: 'Tasted', verdict: 'approve', findings: [], riskLeft };
      return { kind: 'settle', facts: { ...facts, outDoc: outDoc(doc) } };
    });
    const reports = stepReports(batch);
    for (const lens of LENSES) {
      const report = reports.find(({ stepId }) => stepId === lens);
      const own = risks[lens];
      assert.deepEqual(
        report?.tasting,
        { verdict: 'approve', findings: [], ...(own === undefined ? {} : { riskLeft: [own] }) },
        lens,
      );
    }
    const status = renderStatus(
      batch,
      valid(loadRecipes(room)).recipes.find('tasting-room')?.steps,
    );
    assert.ok(status.includes(`- \`correctness\`: ${risks.correctness}`), status);
    assert.ok(status.includes(`- \`security\`: ${risks.security}`), status);
  });

  it('resumes only the lenses that had not ended when the driver was killed mid-group', async () => {
    const store = openSqliteEventStore(':memory:');
    try {
      const { recipes, brewers } = valid(loadRecipes(room));
      let now = new Date('2026-10-23T12:00:00.000Z');
      const driver = (scripts: (attempt: { stepId: string }) => Behaviour) =>
        createBrewing({
          store,
          runner: fakeBrewerRunner(({ ref }) => scripts(ref)),
          recipes,
          limits: (stepId) => {
            const found = brewers.find('tasting-room', stepId);
            return found === undefined ? defaultLimits : attemptLimits(found.brewer);
          },
          clock: () => now,
        });
      // The killed run: correctness and security end, the other lenses' processes die with it.
      const ended = new Set(['correctness', 'security']);
      const killed = driver(({ stepId }) =>
        LENSES.includes(stepId) && !ended.has(stepId) ? behave.lost() : planted({ stepId }),
      );
      assert.ok(killed.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
      store.withTransaction((tx) => {
        tx.append({
          type: 'effect.applied',
          key: effectKey.encode(pullRequestKey('b1')),
          result: PULL_REQUEST,
        });
      });
      assert.ok(
        killed.command({
          kind: 'route',
          batchId: 'b1',
          recipe: 'tasting-room',
          reason: 'label',
          source: 'label',
        }),
      );
      await killed.drive();
      // The restart: the killed run's leases expire at once, and its ticks lose them.
      now = new Date(now.getTime() + 60_000);
      const restarted = driver(planted);
      await restarted.start();
      // The supervisor loses one attempt of a batch per tick.
      for (let tick = 0; tick < 10 && restarted.batch('b1').lane.kind === 'brewing'; tick++) {
        await restarted.tick();
      }
      const events = restarted.events();
      const attempts = (stepId: string) =>
        events.filter((event) => event.type === 'step.started' && event.stepId === stepId).length;
      for (const lens of LENSES) assert.equal(attempts(lens), ended.has(lens) ? 1 : 2, lens);
      assert.deepEqual(restarted.batch('b1').lane, {
        kind: 'on_tap',
        pullRequests: [PULL_REQUEST],
      });
    } finally {
      store.close();
    }
  });
});

describe('a step of several lenses together, brewed (#560, ADR 0220)', () => {
  const step = { id: 'taste', brewer: 'taster', lenses: ['diff/correctness', 'diff/security'] };
  const porter = (fields: Record<string, unknown> = {}) =>
    withRecipe('porter', [
      { id: 'implement', brewer: 'cellarman' },
      { ...step, ...fields },
      { action: 'openPullRequest' },
    ]);
  const correctness = { ...PLANTED.correctness, severity: 'minor', lens: 'diff/correctness' };
  const security = { ...PLANTED.security, lens: 'diff/security' };

  it("blocks a blocking step on any lens's changes, with every lens's findings open on the Stuck reason", async () => {
    const files = porter({
      blocking: true,
      onBlocked: { findings: { goto: 'implement', maxRounds: 1 } },
    });
    const { brewers, recipes } = valid(loadRecipes(files));
    const routes: ({ source: unknown } | undefined)[] = [];
    const { events, batch } = await brew(
      files,
      'porter',
      ({ stepId }) =>
        stepId === 'taste'
          ? tasted('changes', [correctness, security], 'The name is not checked')
          : behave.succeed(),
      (seen, ref) => {
        if (ref.stepId !== 'implement') return;
        routes.push(routeOf(seen, ref, (id) => brewers.find('porter', id)?.brewer.output.doc));
      },
    );
    assert.deepEqual(startedSteps(events), ['implement', 'taste', 'implement', 'taste']);
    assert.deepEqual(batch.lane.kind === 'stuck' && batch.lane.reason, {
      kind: 'blocked',
      stepId: 'taste',
      blockerKind: 'findings',
      summary: 'the Taster asks for changes: The name is not checked',
      roundsOut: { rounds: 1, open: [correctness, security], more: 0 },
    });
    // The one step routed back by its findings, so the route input is its whole out doc, every
    // lens's findings at once (ADR 0128); the fake runner records no worktree to read it from.
    assert.deepEqual(routes[1]?.source, {
      kind: 'route',
      step: 'implement',
      from: 'taste',
      why: 'findings',
    });
    const status = renderStatus(batch, recipes.find('porter')?.steps);
    assert.ok(
      status.includes(
        `- \`taste\`: diff/security, major in ${PLANTED.security?.file}:${PLANTED.security?.line}: `,
      ),
      status,
    );
    assert.ok(status.includes('- `taste`: diff/correctness, minor in '), status);
  });

  it('fails an attempt whose finding names no lens, or a lens not of the step, as an invalid out doc', async () => {
    const unnamed = { ...PLANTED.correctness, severity: 'minor' };
    const { events } = await brew(porter(), 'porter', ({ stepId }) =>
      stepId === 'taste' ? tasted('approve', [unnamed]) : behave.succeed(),
    );
    const failed = events.flatMap((event) =>
      event.type === 'step.finished' && event.stepId === 'taste' && event.outcome.kind === 'failed'
        ? [event.outcome.reason]
        : [],
    );
    assert.equal(failed.length, 2, JSON.stringify(failed));
    assert.ok(
      failed.every((reason) => reason.includes('the out doc taste.md is invalid')),
      failed[0],
    );
    assert.ok(
      failed.every((reason) => reason.includes('findings[0].lens')),
      failed[0],
    );
    const other = { ...security, lens: 'diff/acceptance' };
    const second = await brew(porter(), 'porter', ({ stepId }) =>
      stepId === 'taste' ? tasted('changes', [other]) : behave.succeed(),
    );
    assert.ok(
      second.events.some(
        (event) =>
          event.type === 'step.finished' &&
          event.stepId === 'taste' &&
          event.outcome.kind === 'failed',
      ),
    );
  });

  it("shows each finding's lens in the pull request body and the status comment, ten per lens", async () => {
    const files = porter();
    const many = Array.from({ length: 12 }, (_, at) => ({ ...correctness, line: at + 1 }));
    const { batch } = await brew(files, 'porter', ({ stepId }) =>
      stepId === 'taste' ? tasted('changes', [...many, security], 'Two lenses') : behave.succeed(),
    );
    assert.deepEqual(batch.lane, { kind: 'on_tap', pullRequests: [PULL_REQUEST] });
    const { body } = pullRequestText({
      title: 'Wait for a bottle to be merged',
      closes: { repo: 'acme/brewery', issue: 1 },
      reports: stepReports(batch),
    });
    assert.ok(
      body.includes(
        `  finding: diff/security, major in ${PLANTED.security?.file}:${PLANTED.security?.line}: ${PLANTED.security?.why}`,
      ),
      body,
    );
    assert.ok(
      body.includes(`  finding: diff/correctness, minor in ${PLANTED.correctness?.file}:12: `),
    );
    const status = renderStatus(batch, valid(loadRecipes(files)).recipes.find('porter')?.steps);
    const lines = status.split('\n').filter((line) => line.startsWith('- `taste`: diff/'));
    assert.equal(lines.filter((line) => line.includes('diff/correctness, minor')).length, 10);
    assert.ok(status.includes('- `taste`: and 2 more of diff/correctness\n'), status);
    assert.equal(lines.filter((line) => line.includes('diff/security, major')).length, 1);
  });

  it('caps each lens at ten in the status comment whatever the order of its findings (regression test, review of #571)', async () => {
    const files = porter();
    const many = Array.from({ length: 12 }, (_, at) => ({ ...correctness, line: at + 1 }));
    // A security finding after every fourth correctness finding.
    const mixed = many.flatMap((finding, at) =>
      at % 4 === 3 ? [finding, { ...security, line: at }] : [finding],
    );
    const { batch } = await brew(files, 'porter', ({ stepId }) =>
      stepId === 'taste' ? tasted('changes', mixed, 'Two lenses') : behave.succeed(),
    );
    const status = renderStatus(batch, valid(loadRecipes(files)).recipes.find('porter')?.steps);
    const lines = status.split('\n').filter((line) => line.startsWith('- `taste`: '));
    assert.equal(lines.filter((line) => line.includes('diff/correctness, minor')).length, 10);
    assert.equal(lines.filter((line) => line.includes('diff/security, major')).length, 3);
    assert.deepEqual(
      lines.filter((line) => line.includes(' more')),
      ['- `taste`: and 2 more of diff/correctness'],
    );
  });

  it('shows ten findings of a one-lens step in all, also when some name its lens (review of #571)', async () => {
    const files = withRecipe('porter', [
      { id: 'implement', brewer: 'cellarman' },
      { id: 'taste', brewer: 'taster', lens: 'diff/correctness' },
      { action: 'openPullRequest' },
    ]);
    const unnamed = { ...PLANTED.correctness, severity: 'minor' };
    const findings = Array.from({ length: 15 }, (_, at) =>
      at % 5 === 0
        ? { ...unnamed, line: at + 1, lens: 'diff/correctness' }
        : { ...unnamed, line: at + 1 },
    );
    const { batch } = await brew(files, 'porter', ({ stepId }) =>
      stepId === 'taste' ? tasted('approve', findings) : behave.succeed(),
    );
    const status = renderStatus(batch, valid(loadRecipes(files)).recipes.find('porter')?.steps);
    const lines = status.split('\n').filter((line) => line.startsWith('- `taste`: '));
    assert.equal(lines.filter((line) => line.includes('minor in ')).length, 10, status);
    assert.deepEqual(
      lines.filter((line) => line.includes(' more')),
      ['- `taste`: and 5 more'],
    );
  });
});
