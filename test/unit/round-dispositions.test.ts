// The step a findings route goes back to records a disposition for each finding, and a later
// tasting round gets them (#501, ADR 0191): the earlier rounds' findings, in the order the rounds
// ran, each with what the brewer the route brought back did with it, or open; and the engine's
// fixed text says never to raise a disposed finding again as it was.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { earlierFindingsInput } from '../../src/brewers/attempt-plan.ts';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import type { OutDocRead } from '../../src/brewers/claude-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Disposition, TastingFinding } from '../../src/schemas/out-doc.ts';
import { recipeText } from '../helpers/brewery-files.ts';

const deadline: TastingFinding = {
  file: 'src/wait.ts',
  line: 12,
  severity: 'major',
  why: 'The poll has no deadline',
  introduced: true,
};
const cap: TastingFinding = {
  file: 'src/retry.ts',
  severity: 'minor',
  why: 'Five tries\nis too few',
  introduced: true,
};
const loop: TastingFinding = {
  severity: 'minor',
  why: 'The retry loop sleeps without a jitter',
  introduced: false,
};
const log: TastingFinding = {
  severity: 'blocker',
  why: 'The order asks for a log line',
  introduced: true,
};

const fixed: Disposition = { file: 'src/wait.ts', line: 12, disposition: 'fixed' };
const dismissed: Disposition = {
  file: 'src/retry.ts',
  disposition: 'dismissed',
  why: 'The order\nsets the cap',
};
const preExisting: Disposition = {
  disposition: 'pre-existing',
  why: 'The loop was there before the change',
};

describe('earlierFindingsInput (#501, ADR 0191)', () => {
  it('lists each round in order, each finding with the disposition at its place, or open', () => {
    const input = earlierFindingsInput('tasting', [
      // Paired by place, whatever order the brewer wrote them in.
      {
        step: 'tasting#1',
        findings: [deadline, cap, loop],
        dispositions: [preExisting, dismissed, fixed],
      },
      { step: 'tasting#2', findings: [log], dispositions: [] },
    ]);
    assert.deepEqual(input.source, { kind: 'findings', step: 'tasting' });
    assert.equal(input.name, 'earlierFindings');
    assert.equal(
      input.text,
      [
        'Round tasting#1:',
        '- major in src/wait.ts:12: The poll has no deadline',
        '  fixed',
        '- minor in src/retry.ts: Five tries is too few',
        '  dismissed: The order sets the cap',
        '- minor in the change as a whole, there before the change: The retry loop sleeps without a jitter',
        '  pre-existing: The loop was there before the change',
        '',
        'Round tasting#2:',
        '- blocker in the change as a whole: The order asks for a log line',
        '  open',
      ].join('\n'),
    );
  });

  it('keeps a why the brewer gave a fixed finding, says when a round had none, and when its findings could not be read', () => {
    const { text } = earlierFindingsInput('tasting', [
      {
        step: 'tasting#1',
        findings: [deadline],
        dispositions: [{ ...fixed, why: 'It waits five minutes at most' }],
      },
      { step: 'tasting#2', findings: [], dispositions: [] },
      { step: 'tasting#3', unread: 'it is missing', dispositions: [] },
    ]);
    assert.equal(
      text,
      [
        'Round tasting#1:',
        '- major in src/wait.ts:12: The poll has no deadline',
        '  fixed: It waits five minutes at most',
        '',
        'Round tasting#2:',
        'No findings.',
        '',
        'Round tasting#3:',
        'Its findings could not be read: it is missing.',
      ].join('\n'),
    );
  });

  it('leaves a finding open when no disposition is at its place, and pairs two at one place in order', () => {
    const twice: TastingFinding = { ...deadline, why: 'The poll never backs off' };
    const { text } = earlierFindingsInput('tasting', [
      {
        step: 'tasting#1',
        findings: [deadline, twice, cap],
        // A line the Taster did not write is another place.
        dispositions: [fixed, { ...dismissed, line: 3 }, { ...fixed, why: 'Backs off' }],
      },
    ]);
    assert.equal(
      text,
      [
        'Round tasting#1:',
        '- major in src/wait.ts:12: The poll has no deadline',
        '  fixed',
        '- major in src/wait.ts:12: The poll never backs off',
        '  fixed: Backs off',
        '- minor in src/retry.ts: Five tries is too few',
        '  open',
      ].join('\n'),
    );
  });

  it('holds the input to its limit', () => {
    const long = { ...deadline, why: 'x'.repeat(100_000) };
    const { text } = earlierFindingsInput('tasting', [
      { step: 'tasting#1', findings: [long], dispositions: [] },
    ]);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 64 * 1024);
    assert.match(
      text,
      /\[cut: the rest is past the earlier findings input's limit of 65536 bytes\]$/,
    );
  });
});

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
            onBlocked: { findings: { goto: 'implement', maxRounds: 3 } },
          },
          { action: 'openPullRequest' },
        ],
        { testFirst: false },
      ),
    },
  ],
};

const DEADLINE = '2026-10-25T13:00:00.000Z';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COMMIT = 'c'.repeat(40);

const at = (stepId: string, attempt: number) => ({ batchId: '12-1', stepId, attempt });

const scheduled = (stepId: string, attempt: number, more: object = {}): Event => ({
  type: 'step.scheduled',
  ...at(stepId, attempt),
  deadlineAt: DEADLINE,
  ...more,
});

const started = (stepId: string, attempt: number): Event => ({
  type: 'step.started',
  ...at(stepId, attempt),
  session: { id: SESSION, worktree: join('/work', `${stepId}-${attempt}`) },
  worktree: {
    repo: 'acme/api',
    path: join('/work', `${stepId}-${attempt}`),
    branch: `foedrum/12-1/${stepId}-${attempt}`,
    commit: COMMIT,
  },
});

const succeeded = (stepId: string, attempt: number, more: object = {}): Event => ({
  type: 'step.finished',
  ...at(stepId, attempt),
  outcome: {
    kind: 'succeeded',
    output: { status: 'done', summary: 'Done', assumptions: [], ...more },
  },
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

const routed = { route: { from: 'tasting', why: 'findings' } };

/** A Taster's out doc that asks for changes, with `findings`. */
const changes = (findings: readonly TastingFinding[]) =>
  `---\n${JSON.stringify({ status: 'done', summary: 'Changes', verdict: 'changes', findings })}\n---\n`;

/**
 * Round 1 blocked by two findings, which implement#2 disposed of; round 2 blocked by one more,
 * which implement#3 did not; round 3 started.
 */
const ROUND_ONE: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: DEADLINE },
  {
    type: 'batch.recipe_chosen',
    batchId: '12-1',
    recipe: 'stout',
    reason: 'label',
    source: 'label',
  },
  scheduled('implement', 1),
  started('implement', 1),
  succeeded('implement', 1),
  scheduled('tasting', 1),
  started('tasting', 1),
];

const ROUND_THREE: Event[] = [
  ...ROUND_ONE,
  blockedByFindings(1),
  scheduled('implement', 2, routed),
  started('implement', 2),
  succeeded('implement', 2, { dispositions: [fixed, dismissed] }),
  scheduled('tasting', 2),
  started('tasting', 2),
  blockedByFindings(2),
  scheduled('implement', 3, routed),
  started('implement', 3),
  succeeded('implement', 3),
  scheduled('tasting', 3),
  started('tasting', 3),
];

const OUT_DOCS: Record<string, string | OutDocRead> = {
  [join('/work', 'tasting-1', 'taste.md')]: changes([deadline, cap]),
  [join('/work', 'tasting-2', 'taste.md')]: changes([log]),
};

/** The prompt of attempt `attempt` of the tasting step after `events`, and the files it read. */
const planRound = async (
  events: readonly Event[],
  attempt: number,
  docs = OUT_DOCS,
  stepId = 'tasting',
) => {
  const reads: string[] = [];
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
    git: async (_cwd, args) => ({
      code: 0,
      stdout: args[0] === 'log' ? 'f00dfee Wait\n' : 'diff --git a/x b/x\n',
      stderr: '',
    }),
    files: {
      read: (file): OutDocRead => {
        reads.push(file);
        const doc = docs[file];
        if (doc === undefined) return { kind: 'missing' };
        return typeof doc === 'string' ? { kind: 'text', text: doc } : doc;
      },
      makeFolder: () => {},
    },
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  const ref = at(stepId, attempt);
  const { prompt } = await plans.plan({ ref, limits: plans.limits(ref) });
  return { prompt, reads };
};

/** The text of the input `name` in `prompt`. */
const inputText = (prompt: string, name: string): string => {
  const open = prompt.indexOf(`name="${name}">\n`);
  assert.ok(open >= 0, `the prompt has no input named ${name}`);
  const start = open + `name="${name}">\n`.length;
  return prompt.slice(start, prompt.indexOf('\n</untrusted-input', start));
};

const NEVER_AGAIN = /never raise a fixed, dismissed or pre-existing finding again as it was/i;
// A dismissal stands on its evidence, which a later round checks (#521, ADR 0204).
const EVIDENCE_CHECK =
  /check the evidence a dismissed or pre-existing finding's why names: a file and line, a test, or a sentence of the order or of a decision record\. Treat a dismissed or pre-existing finding whose why names no evidence, or whose evidence does not show what it claims, as held wrong, and raise it once the same way\./i;

describe('a later tasting round gets the earlier findings with their dispositions (#501, ADR 0191)', () => {
  it('gives round 3 both earlier rounds, read from their worktrees, in order, with the dispositions implement wrote', async () => {
    const { prompt, reads } = await planRound(ROUND_THREE, 3);
    assert.ok(reads.includes(join('/work', 'tasting-1', 'taste.md')));
    assert.ok(reads.includes(join('/work', 'tasting-2', 'taste.md')));
    assert.ok(
      prompt.includes(
        `source="the earlier rounds' findings of step tasting, with what was done with them" name="earlierFindings">`,
      ),
    );
    assert.equal(
      inputText(prompt, 'earlierFindings'),
      [
        'Round tasting#1:',
        '- major in src/wait.ts:12: The poll has no deadline',
        '  fixed',
        '- minor in src/retry.ts: Five tries is too few',
        '  dismissed: The order sets the cap',
        '',
        'Round tasting#2:',
        '- blocker in the change as a whole: The order asks for a log line',
        '  open',
      ].join('\n'),
    );
    // The engine's fixed text, before the out doc contract.
    assert.match(prompt, NEVER_AGAIN);
    assert.match(prompt, /raise it once as a new finding that names the old one and says why/i);
    assert.match(prompt, EVIDENCE_CHECK);
    assert.ok(prompt.search(NEVER_AGAIN) < prompt.indexOf('When you finish, write taste.md'));
  });

  it('gives the first round neither the input nor the text', async () => {
    const { prompt } = await planRound(ROUND_ONE, 1);
    assert.doesNotMatch(prompt, /name="earlierFindings"/);
    assert.doesNotMatch(prompt, NEVER_AGAIN);
    assert.doesNotMatch(prompt, EVIDENCE_CHECK);
  });

  it("takes an approving round's findings from its event, and the dispositions of a retry of the routed attempt", async () => {
    const events: Event[] = [
      ...ROUND_ONE,
      blockedByFindings(1),
      scheduled('implement', 2, routed),
      started('implement', 2),
      {
        type: 'step.finished',
        ...at('implement', 2),
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
      },
      scheduled('implement', 3, { retry: true }),
      started('implement', 3),
      succeeded('implement', 3, { dispositions: [fixed, dismissed] }),
      scheduled('tasting', 2),
      started('tasting', 2),
      // Round 2 approved with a finding the change did not bring in; a route from a later step
      // brought the batch back to it.
      succeeded('tasting', 2, { verdict: 'approve', findings: [loop] }),
      scheduled('tasting', 3),
      started('tasting', 3),
    ];
    const { prompt, reads } = await planRound(events, 3);
    assert.deepEqual(reads, [join('/work', 'tasting-1', 'taste.md')]);
    assert.equal(
      inputText(prompt, 'earlierFindings'),
      [
        'Round tasting#1:',
        '- major in src/wait.ts:12: The poll has no deadline',
        '  fixed',
        '- minor in src/retry.ts: Five tries is too few',
        '  dismissed: The order sets the cap',
        '',
        'Round tasting#2:',
        '- minor in the change as a whole, there before the change: The retry loop sleeps without a jitter',
        '  open',
      ].join('\n'),
    );
  });

  it("leaves a round open when the routed attempt that answered it wrote no dispositions, and never takes another step's route", async () => {
    const events: Event[] = [
      ...ROUND_ONE,
      blockedByFindings(1),
      // A check's onFail route back to implement after round 1: not this step's findings.
      scheduled('implement', 2, { route: { from: 'green', why: 'failed' } }),
      started('implement', 2),
      succeeded('implement', 2, { dispositions: [fixed] }),
      scheduled('tasting', 2),
      started('tasting', 2),
    ];
    const text = inputText((await planRound(events, 2)).prompt, 'earlierFindings');
    assert.ok(text.includes('The poll has no deadline\n  open'), text);
    assert.doesNotMatch(text, /fixed/);
  });

  it("says so when an earlier round's out doc cannot be read, and still gives the rest", async () => {
    const { prompt } = await planRound(ROUND_THREE, 3, {
      [join('/work', 'tasting-2', 'taste.md')]: changes([log]),
    });
    const text = inputText(prompt, 'earlierFindings');
    assert.ok(
      text.startsWith('Round tasting#1:\nIts findings could not be read: it is missing.'),
      text,
    );
    assert.ok(text.includes('Round tasting#2:\n- blocker in the change as a whole'), text);
  });
});

/** Round 1 blocked by findings, and implement#2, routed back by them, done with `dispositions`. */
const DISPOSED: Event[] = [
  ...ROUND_ONE,
  blockedByFindings(1),
  scheduled('implement', 2, routed),
  started('implement', 2),
  succeeded('implement', 2, { dispositions: [fixed, dismissed] }),
];

const ROUND_ONE_DISPOSED = [
  'Round tasting#1:',
  '- major in src/wait.ts:12: The poll has no deadline',
  '  fixed',
  '- minor in src/retry.ts: Five tries is too few',
  '  dismissed: The order sets the cap',
].join('\n');

describe('which attempts give a round its findings and dispositions (review of #517)', () => {
  it("keeps a round's dispositions when a later attempt of that step, which no route of it brought back, writes none", async () => {
    const events: Event[] = [
      ...DISPOSED,
      // A check's onFail route back to implement: not an answer to round 1.
      scheduled('implement', 3, { route: { from: 'green', why: 'failed' } }),
      started('implement', 3),
      succeeded('implement', 3),
      scheduled('tasting', 2),
      started('tasting', 2),
    ];
    assert.equal(
      inputText((await planRound(events, 2)).prompt, 'earlierFindings'),
      ROUND_ONE_DISPOSED,
    );
  });

  for (const route of [
    // Another lens's findings, as a sibling of a parallel group sends the batch back (ADR 0168).
    { from: 'other-lens', why: 'findings' },
    // This step's route, but not for findings.
    { from: 'tasting', why: 'failed' },
  ]) {
    it(`never takes the dispositions of an attempt a route from ${route.from} for ${route.why} brought back`, async () => {
      const events: Event[] = [
        ...ROUND_ONE,
        blockedByFindings(1),
        scheduled('implement', 2, { route }),
        started('implement', 2),
        succeeded('implement', 2, { dispositions: [fixed, dismissed] }),
        scheduled('tasting', 2),
        started('tasting', 2),
      ];
      const text = inputText((await planRound(events, 2)).prompt, 'earlierFindings');
      assert.ok(text.includes('The poll has no deadline\n  open'), text);
      assert.ok(text.includes('Five tries is too few\n  open'), text);
    });
  }

  it('gives a step whose brewer is not a Taster no earlier findings, though an earlier attempt of it was blocked by findings', async () => {
    const events: Event[] = [
      ...ROUND_ONE.slice(0, -3),
      // No Gauger ran, so the Cellarman has no tests input.
      { type: 'step.skipped', batchId: '12-1', stepId: 'gauge', when: 'false' },
      {
        type: 'step.finished',
        ...at('implement', 1),
        outcome: {
          kind: 'failed',
          retryable: false,
          reason: 'blocked (findings): a test of the Gauger is wrong',
        },
      },
      scheduled('implement', 2),
      started('implement', 2),
    ];
    const { prompt, reads } = await planRound(events, 2, OUT_DOCS, 'implement');
    assert.doesNotMatch(prompt, /name="earlierFindings"/);
    assert.doesNotMatch(prompt, NEVER_AGAIN);
    assert.deepEqual(reads, []);
  });

  it('takes the dispositions of an answered attempt that continued the routed one', async () => {
    const events: Event[] = [
      ...ROUND_ONE,
      blockedByFindings(1),
      scheduled('implement', 2, routed),
      started('implement', 2),
      {
        type: 'step.finished',
        ...at('implement', 2),
        outcome: {
          kind: 'needs_input',
          questions: [
            {
              q: 'Keep the cap?',
              options: ['keep', 'raise'],
              recommended: 'keep',
              whyBlocking: 'x',
            },
          ],
        },
      },
      scheduled('implement', 3, { answered: true }),
      started('implement', 3),
      succeeded('implement', 3, { dispositions: [fixed, dismissed] }),
      scheduled('tasting', 2),
      started('tasting', 2),
    ];
    assert.equal(
      inputText((await planRound(events, 2)).prompt, 'earlierFindings'),
      ROUND_ONE_DISPOSED,
    );
  });

  it('never counts an earlier attempt of the step that reviewed nothing as a round', async () => {
    const events: Event[] = [
      ...ROUND_ONE,
      {
        type: 'step.finished',
        ...at('tasting', 1),
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
      },
      scheduled('tasting', 2, { retry: true }),
      started('tasting', 2),
    ];
    const { prompt, reads } = await planRound(events, 2);
    assert.doesNotMatch(prompt, /name="earlierFindings"/);
    assert.doesNotMatch(prompt, NEVER_AGAIN);
    assert.deepEqual(reads, []);
  });

  it("reads a blocked round's out doc in its attempt's worktree, else its session's, and says so when neither is recorded", async () => {
    const session = (stepId: string, attempt: number, folder?: string): Event => ({
      type: 'step.started',
      ...at(stepId, attempt),
      ...(folder === undefined
        ? {}
        : { session: { id: SESSION, worktree: join('/work', folder) } }),
    });
    const events: Event[] = [
      ...ROUND_ONE.slice(0, -1),
      // Round 1 ran in its own worktree, beside another session folder.
      {
        type: 'step.started',
        ...at('tasting', 1),
        session: { id: SESSION, worktree: join('/work', 'session-1') },
        worktree: {
          repo: 'acme/api',
          path: join('/work', 'tasting-1'),
          branch: 'foedrum/12-1/tasting-1',
          commit: COMMIT,
        },
      },
      blockedByFindings(1),
      // Round 2 resumed a session and recorded no worktree of its own.
      scheduled('tasting', 2),
      session('tasting', 2, 'session-2'),
      blockedByFindings(2),
      // Round 3 recorded neither.
      scheduled('tasting', 3),
      session('tasting', 3),
      blockedByFindings(3),
      scheduled('tasting', 4),
      started('tasting', 4),
    ];
    const { prompt, reads } = await planRound(events, 4, {
      [join('/work', 'tasting-1', 'taste.md')]: changes([deadline]),
      [join('/work', 'session-2', 'taste.md')]: changes([log]),
    });
    assert.deepEqual(reads, [
      join('/work', 'tasting-1', 'taste.md'),
      join('/work', 'session-2', 'taste.md'),
    ]);
    assert.equal(
      inputText(prompt, 'earlierFindings'),
      [
        'Round tasting#1:',
        '- major in src/wait.ts:12: The poll has no deadline',
        '  open',
        '',
        'Round tasting#2:',
        '- blocker in the change as a whole: The order asks for a log line',
        '  open',
        '',
        'Round tasting#3:',
        'Its findings could not be read: no worktree of it is recorded.',
      ].join('\n'),
    );
  });

  it("says why a blocked round's out doc that is invalid, or that the read refused, could not be read", async () => {
    const { prompt } = await planRound(ROUND_THREE, 3, {
      [join('/work', 'tasting-1', 'taste.md')]:
        '---\n{ "status": "done", "summary": "x", "verdict": "maybe" }\n---\n',
      [join('/work', 'tasting-2', 'taste.md')]: {
        kind: 'unread',
        reason: 'it is larger than 1048576 bytes',
      },
    });
    const text = inputText(prompt, 'earlierFindings');
    // The schema's reason spans lines; the round reads it on one.
    assert.match(
      text,
      /^Round tasting#1:\nIts findings could not be read: its out doc is invalid: [^\n]*at verdict\.\n\nRound tasting#2:/,
    );
    assert.ok(
      text.endsWith(
        'Round tasting#2:\nIts findings could not be read: it is larger than 1048576 bytes.',
      ),
      text,
    );
  });
});

describe('earlierFindingsInput: a step of several lenses together (#560, ADR 0220)', () => {
  it("shows each finding's lens, and gives two lenses' findings at one place a disposition each, in order", () => {
    const { text } = earlierFindingsInput('taste', [
      {
        step: 'taste#1',
        findings: [
          { ...deadline, lens: 'diff/correctness' },
          { ...deadline, severity: 'minor', why: 'The wait is not logged', lens: 'diff/security' },
        ],
        dispositions: [
          fixed,
          { ...fixed, disposition: 'dismissed', why: 'The log is in run.ts:4' },
        ],
      },
    ]);
    assert.equal(
      text,
      [
        'Round taste#1:',
        '- diff/correctness, major in src/wait.ts:12: The poll has no deadline',
        '  fixed',
        '- diff/security, minor in src/wait.ts:12: The wait is not logged',
        '  dismissed: The log is in run.ts:4',
      ].join('\n'),
    );
  });
});
