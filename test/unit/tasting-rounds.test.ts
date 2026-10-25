// A later tasting round reviews the change since the round before (#500, ADR 0190, ADR 0196): a
// lens step's attempt after an earlier attempt of it that reviewed (a verdict, or blocked by
// findings, whatever sent the batch back) gets the change from the commit that round reviewed to
// HEAD beside the whole change, and the engine's fixed text says to review only that. The first
// round is unchanged, and a retry or an answered attempt reviews what its round reviews.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import type { Git } from '../../src/workspace/git.ts';
import { recipeText } from '../helpers/brewery-files.ts';

const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));
const files = {
  ...noFiles,
  recipes: [
    {
      path: 'recipes/stout.jsonc',
      text: recipeText(
        'stout',
        [
          { id: 'implement', brewer: 'cellarman' },
          {
            id: 'tasting',
            brewer: 'taster',
            lens: 'diff/correctness',
            blocking: true,
            onBlocked: { findings: { goto: 'implement', maxRounds: 2 } },
          },
          { action: 'openPullRequest' },
        ],
        { testFirst: false },
      ),
    },
  ],
};

const BASE = 'a'.repeat(40);
const ROUND1 = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const DEADLINE = '2026-10-25T13:00:00.000Z';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

const worktree = (name: string, commit: string) => ({
  repo: 'acme/api',
  path: join('/work', name),
  branch: `foedrum/12-1/${name}`,
  commit,
});

const at = (stepId: string, attempt: number) => ({ batchId: '12-1', stepId, attempt });

const started = (stepId: string, attempt: number, commit: string): Event => ({
  type: 'step.started',
  ...at(stepId, attempt),
  session: { id: SESSION, worktree: join('/work', `${stepId}-${attempt}`) },
  worktree: worktree(`${stepId}-${attempt}`, commit),
});

const succeeded = (stepId: string, attempt: number): Event => ({
  type: 'step.finished',
  ...at(stepId, attempt),
  outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Done', assumptions: [] } },
});

const blockedByFindings = (attempt: number): Event => ({
  type: 'step.finished',
  ...at('tasting', attempt),
  outcome: {
    kind: 'failed',
    retryable: false,
    reason: 'blocked (findings): the Taster asks for changes: The poll has no deadline',
  },
});

const ROUND_ONE: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: DEADLINE },
  {
    type: 'batch.recipe_chosen',
    batchId: '12-1',
    recipe: 'stout',
    reason: 'label',
    source: 'label',
  },
  { type: 'step.scheduled', ...at('implement', 1), deadlineAt: DEADLINE },
  started('implement', 1, BASE),
  succeeded('implement', 1),
  { type: 'step.scheduled', ...at('tasting', 1), deadlineAt: DEADLINE },
  started('tasting', 1, ROUND1),
];

/** Round 1 blocked by findings, the route back to implement, and round 2 started at HEAD. */
const ROUND_TWO: Event[] = [
  ...ROUND_ONE,
  blockedByFindings(1),
  {
    type: 'step.scheduled',
    ...at('implement', 2),
    deadlineAt: DEADLINE,
    route: { from: 'tasting', why: 'findings' },
  },
  started('implement', 2, ROUND1),
  succeeded('implement', 2),
  { type: 'step.scheduled', ...at('tasting', 2), deadlineAt: DEADLINE },
  started('tasting', 2, HEAD),
];

const LOG = 'f00dfee Wait for a bottle to be merged';
const FIX_LOG = 'beefcafe Give the poll a deadline';
const DIFF = 'diff --git a/src/wait.ts b/src/wait.ts\n+  while (!(await isMerged())) {}';
const FIX_DIFF = 'diff --git a/src/wait.ts b/src/wait.ts\n+  if (Date.now() > deadline) break;';

/**
 * git as the clone answers it: the whole change from BASE, the fix from ROUND1, and
 * `merge-base --is-ancestor <a> <b>` true only when `a` comes no later than `b` on `line`, the
 * batch's line of commits, oldest first.
 */
const gitOn =
  (line: readonly string[]): Git =>
  async (_cwd, args) => {
    if (args[0] === 'merge-base') {
      const [a = '', b = ''] = args.slice(-2);
      const onLine = line.includes(a) && line.includes(b) && line.indexOf(a) <= line.indexOf(b);
      return { code: onLine ? 0 : 1, stdout: '', stderr: '' };
    }
    return changeOf(args);
  };

const changeOf = (args: readonly string[]) => {
  const fix = args.includes(`${ROUND1}..${HEAD}`) || args.includes(ROUND1);
  if (args[0] === 'log') return { code: 0, stdout: `${fix ? FIX_LOG : LOG}\n`, stderr: '' };
  return { code: 0, stdout: `${fix ? FIX_DIFF : DIFF}\n`, stderr: '' };
};

const answers = gitOn([BASE, ROUND1, HEAD]);

/** The plan of attempt `attempt` of the tasting step after `events`, and the git calls it made. */
const planRound = async (
  events: readonly Event[],
  attempt: number,
  { git = answers }: { git?: Git } = {},
) => {
  const calls: (readonly string[])[] = [];
  const dirs: string[] = [];
  const plans = createAttemptPlans({
    state: () => fold(events),
    brewers: (() => {
      const loaded = loadRecipes(files);
      assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
      return loaded.brewers;
    })(),
    models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
    repoTools: () => [],
    clone: (repo) => join('/clones', repo),
    sandbox: false,
    workRoot: join('/root'),
    env: { base: { PATH: '/usr/bin' }, forced: {} },
    platform: 'linux',
    orderText: async () => 'Wait for a bottle to be merged.',
    git: (cwd, args, options) => {
      calls.push(args);
      dirs.push(cwd);
      return git(cwd, args, options);
    },
    files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  const ref = at('tasting', attempt);
  const { prompt } = await plans.plan({ ref, limits: plans.limits(ref) });
  return { prompt, calls, dirs };
};

/** The text of the input `name` in `prompt`. */
const inputText = (prompt: string, name: string): string => {
  const open = prompt.indexOf(`name="${name}">\n`);
  assert.ok(open >= 0, `the prompt has no input named ${name}`);
  const start = open + `name="${name}">\n`.length;
  return prompt.slice(start, prompt.indexOf('\n</untrusted-input', start));
};

const LATER_ROUND = /review only the change since the round before/i;

describe('a later tasting round (#500, ADR 0190)', () => {
  it('gives the first round the whole change alone, without the text of a later round', async () => {
    const { prompt, calls } = await planRound(ROUND_ONE, 1);
    assert.ok(prompt.includes(`source="the change since commit ${BASE}" name="change">`));
    assert.doesNotMatch(prompt, /name="roundChange"/);
    assert.doesNotMatch(prompt, LATER_ROUND);
    assert.doesNotMatch(prompt, /round before/);
    assert.deepEqual(
      calls.map((args) => args.find((arg) => arg === 'log' || arg === 'diff')),
      ['log', 'diff'],
    );
  });

  it('gives round 2 after a findings route the change since the commit round 1 reviewed, beside the whole change', async () => {
    const { prompt, calls, dirs } = await planRound(ROUND_TWO, 2);
    // Every read, the merge-base checks too, in the clone, never in a worktree (ADR 0137).
    assert.ok(dirs.includes(join('/clones', 'acme/api')));
    assert.deepEqual(
      dirs.filter((dir) => dir !== join('/clones', 'acme/api')),
      [],
    );
    assert.ok(calls.some((args) => args[0] === 'merge-base'));
    assert.ok(
      prompt.includes(
        `An earlier round of this step, tasting#1, reviewed the change up to commit ${ROUND1}.`,
      ),
    );
    const whole = inputText(prompt, 'change');
    assert.ok(whole.includes(LOG) && whole.includes(DIFF), whole);
    assert.ok(
      prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`),
      'the prompt does not hold the change since round 1',
    );
    const since = inputText(prompt, 'roundChange');
    assert.ok(since.includes(FIX_LOG) && since.includes(FIX_DIFF), since);
    assert.doesNotMatch(since, /while \(!\(await isMerged/);
    // Read as the change is: first parents, no diff driver, in the clone.
    assert.ok(
      calls.some(
        (args) =>
          args[0] === 'log' &&
          args.includes('--first-parent') &&
          args.includes(`${ROUND1}..${HEAD}`),
      ),
    );
    assert.ok(
      calls.some(
        (args) =>
          args.includes('diff') &&
          args.includes('--no-ext-diff') &&
          args.includes('--no-textconv') &&
          args.at(-2) === ROUND1 &&
          args.at(-1) === HEAD,
      ),
    );
    // The engine's fixed text, before the out doc contract.
    assert.match(prompt, LATER_ROUND);
    assert.match(prompt, /a fix brought in/);
    assert.match(prompt, /leave alone what the earlier round already reviewed/i);
    assert.ok(prompt.indexOf('round before') < prompt.indexOf('When you finish, write taste.md'));
  });

  it('gives round 3 the change since round 2, the latest round before it, never since round 1', async () => {
    const later = 'b'.repeat(40);
    // Round 2, at HEAD, was blocked by findings too, and round 3 starts at `later`.
    const third: Event[] = [
      ...ROUND_TWO,
      blockedByFindings(2),
      {
        type: 'step.scheduled',
        ...at('implement', 3),
        deadlineAt: DEADLINE,
        route: { from: 'tasting', why: 'findings' },
      },
      started('implement', 3, HEAD),
      succeeded('implement', 3),
      { type: 'step.scheduled', ...at('tasting', 3), deadlineAt: DEADLINE },
      started('tasting', 3, later),
    ];
    const { prompt, calls } = await planRound(third, 3, {
      git: gitOn([BASE, ROUND1, HEAD, later]),
    });
    assert.ok(prompt.includes(`source="the change since commit ${HEAD}" name="roundChange">`));
    assert.ok(prompt.includes(`An earlier round of this step, tasting#2, reviewed`));
    assert.ok(calls.some((args) => args[0] === 'log' && args.includes(`${HEAD}..${later}`)));
    assert.ok(calls.every((args) => !args.includes(`${ROUND1}..${later}`)));
  });

  it('gives a retry of a round 2 that was blocked by findings what round 2 reviews: the change since round 1', async () => {
    const later = 'b'.repeat(40);
    // Round 2 ran out of rounds and the batch went Stuck; a human's retry schedules attempt 3.
    const events: Event[] = [
      ...ROUND_TWO,
      blockedByFindings(2),
      { type: 'step.scheduled', ...at('tasting', 3), deadlineAt: DEADLINE, retry: true },
      started('tasting', 3, later),
    ];
    const { prompt } = await planRound(events, 3, { git: gitOn([BASE, ROUND1, HEAD, later]) });
    assert.ok(prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`));
    assert.ok(prompt.includes('An earlier round of this step, tasting#1, reviewed'));
    assert.doesNotMatch(prompt, /tasting#2, reviewed/);
  });

  it('gives a round after an earlier attempt that never finished no change since it: it reviewed nothing (ADR 0196)', async () => {
    // Attempt 1 started at ROUND1 and was lost; attempt 2 is scheduled afresh.
    const events: Event[] = [
      ...ROUND_ONE,
      { type: 'step.scheduled', ...at('tasting', 2), deadlineAt: DEADLINE },
      started('tasting', 2, HEAD),
    ];
    const { prompt } = await planRound(events, 2);
    assert.doesNotMatch(prompt, /name="roundChange"/);
    assert.doesNotMatch(prompt, /round before/);
  });

  it('passes over an earlier attempt that reviewed nothing to the latest round that did (ADR 0196)', async () => {
    const between = 'b'.repeat(40);
    // Attempt 2 started at `between` and failed without a retry; attempt 3 starts at HEAD.
    const events: Event[] = [
      ...ROUND_ONE,
      blockedByFindings(1),
      { type: 'step.scheduled', ...at('tasting', 2), deadlineAt: DEADLINE },
      started('tasting', 2, between),
      {
        type: 'step.finished',
        ...at('tasting', 2),
        outcome: { kind: 'failed', retryable: false, reason: 'claude crashed' },
      },
      { type: 'step.scheduled', ...at('tasting', 3), deadlineAt: DEADLINE },
      started('tasting', 3, HEAD),
    ];
    const { prompt } = await planRound(events, 3, { git: gitOn([BASE, ROUND1, between, HEAD]) });
    assert.ok(prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`));
    assert.ok(prompt.includes('An earlier round of this step, tasting#1, reviewed'));
  });

  it('gives a retry of round 2 what round 2 reviews: the change since round 1', async () => {
    const retried: Event[] = [
      ...ROUND_TWO,
      {
        type: 'step.finished',
        ...at('tasting', 2),
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
      },
      { type: 'step.scheduled', ...at('tasting', 3), deadlineAt: DEADLINE, retry: true },
      {
        type: 'step.started',
        ...at('tasting', 3),
        session: {
          id: 'b4b8a9a4-3f4e-4c2a-9a63-6f4f0c3c5d10',
          worktree: join('/work', 'tasting-3'),
        },
        worktree: worktree('tasting-3', HEAD),
      },
    ];
    const { prompt } = await planRound(retried, 3);
    assert.ok(prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`));
    assert.match(prompt, LATER_ROUND);
  });

  it('gives a retry of round 1 no change since a round before', async () => {
    const retried: Event[] = [
      ...ROUND_ONE,
      {
        type: 'step.finished',
        ...at('tasting', 1),
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
      },
      { type: 'step.scheduled', ...at('tasting', 2), deadlineAt: DEADLINE, retry: true },
      {
        type: 'step.started',
        ...at('tasting', 2),
        session: {
          id: 'b4b8a9a4-3f4e-4c2a-9a63-6f4f0c3c5d10',
          worktree: join('/work', 'tasting-2'),
        },
        worktree: worktree('tasting-2', ROUND1),
      },
    ];
    const { prompt } = await planRound(retried, 2);
    assert.doesNotMatch(prompt, /name="roundChange"/);
    assert.doesNotMatch(prompt, /round before/);
  });

  it('gives no second input when the commit round 1 reviewed cannot be found, and says so', async () => {
    // Round 1 recorded no worktree of its own and resumed no session: nothing names its commit.
    const lost = ROUND_TWO.map((event) =>
      event.type === 'step.started' && event.stepId === 'tasting' && event.attempt === 1
        ? { type: 'step.started' as const, ...at('tasting', 1) }
        : event,
    );
    const { prompt, calls } = await planRound(lost, 2);
    assert.doesNotMatch(prompt, /name="roundChange"/);
    assert.doesNotMatch(prompt, LATER_ROUND);
    assert.match(prompt, /the change since the round before could not be read/i);
    assert.match(prompt, /could not be read: no commit it reviewed is recorded\./);
    assert.match(prompt, /An earlier round of this step, tasting#1, reviewed the change, but/);
    assert.doesNotMatch(prompt, /sent (it|the change) back/);
    assert.match(prompt, /review the whole change/i);
    assert.ok(
      calls.every((args) => !args.includes(ROUND1) && !args.includes(`${ROUND1}..${HEAD}`)),
    );
  });

  it('gives no second input when the commit round 1 reviewed is not on the line to HEAD, as after a rewind', async () => {
    // The rewound line holds HEAD, but not the commit round 1 reviewed.
    const rewound = gitOn([BASE, HEAD]);
    const { prompt, calls } = await planRound(ROUND_TWO, 2, { git: rewound });
    assert.doesNotMatch(prompt, /name="roundChange"/);
    assert.match(
      prompt,
      new RegExp(
        `could not be read: the commit it reviewed, ${ROUND1}, is not on the line to HEAD\\.`,
      ),
    );
    assert.ok(
      calls.every((args) => args[0] === 'merge-base' || !args.includes(`${ROUND1}..${HEAD}`)),
    );
  });

  it('gives no second input when a merge of the base since round 1 would put what the base added in it (ADR 0164)', async () => {
    const merged = 'e'.repeat(40);
    // A merge after round 1 brought the base in at `merged`, which round 1 did not hold.
    const events: Event[] = [
      ...ROUND_TWO.slice(0, -2),
      {
        type: 'effect.applied',
        key: '["12-1","implement",2,"merge_base"]',
        result: { base: merged, merged: HEAD },
      },
      ...ROUND_TWO.slice(-2),
    ];
    const { prompt } = await planRound(events, 2, { git: gitOn([BASE, ROUND1, merged, HEAD]) });
    assert.ok(prompt.includes(`source="the change since commit ${merged}" name="change">`));
    assert.doesNotMatch(prompt, /name="roundChange"/);
    assert.match(
      prompt,
      new RegExp(`could not be read: the base was merged in since, at ${merged}\\.`),
    );
  });

  it('gives round 2 the change since round 1 when the base was merged in before round 1 (ADR 0164)', async () => {
    const merged = 'e'.repeat(40);
    // The merge came before round 1, which held it.
    const events: Event[] = [
      ...ROUND_ONE.slice(0, -2),
      {
        type: 'effect.applied',
        key: '["12-1","implement",1,"merge_base"]',
        result: { base: merged, merged: ROUND1 },
      },
      ...ROUND_TWO.slice(ROUND_ONE.length - 2),
    ];
    const { prompt } = await planRound(events, 2, { git: gitOn([BASE, merged, ROUND1, HEAD]) });
    assert.ok(prompt.includes(`source="the change since commit ${merged}" name="change">`));
    assert.ok(prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`));
    assert.match(prompt, LATER_ROUND);
  });

  for (const verdict of ['approve', 'changes']) {
    it(`gives a round after one that succeeded with the verdict ${verdict} the change since it, as a group child sent back by a sibling (ADR 0196)`, async () => {
      const reviewed: StepOutcome = {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Tasted', assumptions: [], verdict, findings: [] },
      };
      const events = ROUND_TWO.map((event) =>
        event.type === 'step.finished' && event.stepId === 'tasting' && event.attempt === 1
          ? { ...event, outcome: reviewed }
          : event,
      );
      const { prompt } = await planRound(events, 2);
      assert.ok(prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`));
      assert.ok(
        prompt.includes(
          `An earlier round of this step, tasting#1, reviewed the change up to commit ${ROUND1}.`,
        ),
      );
      assert.match(prompt, LATER_ROUND);
    });
  }

  it('gives a lens that runs again after a check sent the batch back past it the change since its round (ADR 0196)', async () => {
    const approved: StepOutcome = {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Tasted', assumptions: [], verdict: 'approve' },
    };
    // Round 1 approved; a later check's onFail route went back to implement, past it.
    const events: Event[] = [
      ...ROUND_ONE,
      { type: 'step.finished', ...at('tasting', 1), outcome: approved },
      {
        type: 'step.scheduled',
        ...at('implement', 2),
        deadlineAt: DEADLINE,
        route: { from: 'green', why: 'failed' },
      },
      started('implement', 2, ROUND1),
      succeeded('implement', 2),
      { type: 'step.scheduled', ...at('tasting', 2), deadlineAt: DEADLINE },
      started('tasting', 2, HEAD),
    ];
    const { prompt } = await planRound(events, 2);
    assert.ok(prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`));
  });

  for (const [why, outcome] of [
    [
      'succeeded without a verdict',
      {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Done', assumptions: [] },
      },
    ],
    ['failed for another reason', { kind: 'failed', retryable: false, reason: 'claude crashed' }],
    [
      'was blocked on its environment',
      { kind: 'failed', retryable: false, reason: 'blocked (environment): no network' },
    ],
    ['was cancelled', { kind: 'cancelled' }],
    [
      'failed retryably with the reason of a findings block',
      { kind: 'failed', retryable: true, reason: 'blocked (findings): not settled by decide' },
    ],
    [
      'asked a question nobody answered',
      {
        kind: 'needs_input',
        questions: [
          {
            q: 'Which deadline?',
            options: ['1m', '5m'],
            recommended: '1m',
            whyBlocking: 'It decides',
          },
        ],
      },
    ],
  ] satisfies [string, StepOutcome][]) {
    it(`gives a round after an earlier attempt that ${why} no change since it: that attempt reviewed nothing (ADR 0196)`, async () => {
      const events = ROUND_TWO.map((event) =>
        event.type === 'step.finished' && event.stepId === 'tasting' && event.attempt === 1
          ? { ...event, outcome }
          : event,
      );
      const { prompt } = await planRound(events, 2);
      assert.doesNotMatch(prompt, /name="roundChange"/);
      assert.doesNotMatch(prompt, /round before/);
    });
  }

  it('gives an attempt after a human answered round 2 what round 2 reviews: the change since round 1', async () => {
    const answered: Event[] = [
      ...ROUND_TWO,
      {
        type: 'step.finished',
        ...at('tasting', 2),
        outcome: {
          kind: 'needs_input',
          questions: [
            {
              q: 'Which deadline?',
              options: ['1m', '5m'],
              recommended: '1m',
              whyBlocking: 'It decides',
            },
          ],
        },
      },
      { type: 'step.scheduled', ...at('tasting', 3), deadlineAt: DEADLINE, answered: true },
      {
        type: 'step.started',
        ...at('tasting', 3),
        session: {
          id: 'b4b8a9a4-3f4e-4c2a-9a63-6f4f0c3c5d10',
          worktree: join('/work', 'tasting-3'),
        },
        worktree: worktree('tasting-3', HEAD),
      },
    ];
    const { prompt } = await planRound(answered, 3);
    assert.ok(prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`));
  });

  it('reads a round before in the same repository named in another case, and none from another repository', async () => {
    const inRepo = (repo: string) =>
      ROUND_TWO.map((event) =>
        event.type === 'step.started' && event.stepId === 'tasting' && event.attempt === 1
          ? { ...event, worktree: { ...worktree('tasting-1', ROUND1), repo } }
          : event,
      );
    const same = await planRound(inRepo('Acme/API'), 2);
    assert.ok(
      same.prompt.includes(`source="the change since commit ${ROUND1}" name="roundChange">`),
    );
    const other = await planRound(inRepo('acme/web'), 2);
    assert.doesNotMatch(other.prompt, /name="roundChange"/);
    assert.match(other.prompt, /could not be read: it reviewed acme\/web, not acme\/api\./);
  });

  it('says git could not tell, never that the commit is off the line, when merge-base fails', async () => {
    const failing: Git = async (cwd, args, options) =>
      args[0] === 'merge-base'
        ? { code: 128, stdout: '', stderr: `fatal: Not a valid commit name ${ROUND1}` }
        : answers(cwd, args, options);
    const { prompt } = await planRound(ROUND_TWO, 2, { git: failing });
    assert.doesNotMatch(prompt, /name="roundChange"/);
    assert.doesNotMatch(prompt, /is not on the line to HEAD/);
    assert.match(prompt, /could not be read: git merge-base exited with code 128\./);
    const killed: Git = async (cwd, args, options) =>
      args[0] === 'merge-base'
        ? { code: null, stdout: '', stderr: '', killed: 'timed-out' }
        : answers(cwd, args, options);
    const late = await planRound(ROUND_TWO, 2, { git: killed });
    assert.match(late.prompt, /could not be read: git merge-base was killed \(timed-out\)\./);
  });
});
