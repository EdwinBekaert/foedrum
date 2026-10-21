import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import {
  type Attempt,
  type Batch,
  emptyState,
  fold,
  type Lane,
  type State,
} from '../../src/engine/fold.ts';
import { worktreeClaims } from '../../src/engine/worktree-claims.ts';
import type { Event } from '../../src/schemas/events.ts';
import { planClean } from '../../src/workspace/attempt-worktrees.ts';

const batch = (id: string, lane: Lane): Batch => ({
  id,
  issue: 1,
  lane,
  steps: new Map(),
  rewinds: [],
});

const lanes: Record<string, Lane> = {
  ordered: { kind: 'ordered', routeBy: '2026-10-15T00:00:00.000Z' },
  brewing: { kind: 'brewing' },
  conditioning: {
    kind: 'conditioning',
    on: { kind: 'sibling', batchId: 'brewing' },
    remindAt: '2026-10-15T00:00:00.000Z',
  },
  stuck: {
    kind: 'stuck',
    reason: { kind: 'waiting_for_session', stepId: 'implement' },
    options: ['retry'],
    remindAt: '2026-10-15T00:00:00.000Z',
  },
  'on-tap': { kind: 'on_tap', pullRequests: ['https://github.com/acme/app/pull/1'] },
  cancelled: { kind: 'cancelled', by: 'me', via: 'terminal' },
};

describe('worktreeClaims', () => {
  it('keeps every batch live until it is on tap or cancelled', () => {
    const state = {
      ...emptyState,
      batches: new Map(Object.entries(lanes).map(([id, lane]) => [id, batch(id, lane)])),
    };

    const claims = worktreeClaims(state, []);

    assert.deepEqual(
      claims.batches,
      new Map([
        ['ordered', 'live'],
        ['brewing', 'live'],
        ['conditioning', 'live'],
        // A Stuck batch keeps its worktrees: a human may take over or resume.
        ['stuck', 'live'],
        ['on-tap', 'ended'],
        ['cancelled', 'ended'],
      ]),
    );
  });

  it('names the attempts of the live leases, and skips a lease that names no attempt', () => {
    const expiresAt = new Date('2026-10-15T00:00:00.000Z');
    const attempt = { batchId: '12-1', stepId: 'implement', attempt: 2 };
    const leases = [
      { attemptKey: attemptKey.encode(attempt), owner: 'driver', expiresAt },
      { attemptKey: 'batch 12-1', owner: 'driver', expiresAt },
    ];

    assert.deepEqual(worktreeClaims(emptyState, leases).leased, [attempt]);
  });

  it('names the out doc of every step of an ended batch whose brewer is known (ADR 0081)', () => {
    const steps = new Map(
      ['brew', 'check'].map((id) => [id, { id, attempts: new Map(), inputs: [] }]),
    );
    const state = {
      ...emptyState,
      batches: new Map(
        (['brewing', 'stuck', 'on-tap', 'cancelled'] as const).map((id) => [
          id,
          { ...batch(id, lanes[id] as Lane), steps },
        ]),
      ),
    };
    const asked: string[] = [];
    // A check step has no brewer, so no out doc.
    const outDoc = ({ batchId, stepId }: { batchId: string; stepId: string }) => {
      asked.push(`${batchId}/${stepId}`);
      return stepId === 'brew' ? 'brew.md' : undefined;
    };

    const claims = worktreeClaims(state, [], outDoc);

    assert.deepEqual(
      claims.outDocs,
      new Map([
        ['on-tap/brew', 'brew.md'],
        ['cancelled/brew', 'brew.md'],
      ]),
    );
    // A live batch keeps its worktrees anyway: its brewers are not looked up.
    assert.deepEqual(asked, ['on-tap/brew', 'on-tap/check', 'cancelled/brew', 'cancelled/check']);
  });
});

describe('worktreeClaims: the task tree no push recorded (ADR 0084)', () => {
  const BASE = 'b'.repeat(40);
  const TIP = 'c'.repeat(40);
  type Outcome = Extract<Attempt, { phase: 'finished' }>['outcome'];
  const finished = (
    stepId: string,
    attempt: number,
    commit: string,
    outcome: Outcome = { kind: 'succeeded', output: {} },
  ): Attempt => ({
    phase: 'finished',
    attempt,
    deadlineAt: '2026-10-15T00:00:00.000Z',
    worktree: {
      repo: 'acme/app',
      path: `/work/acme.app/attempts/12-1/${stepId}/${attempt}`,
      branch: `foedrum/12-1/${stepId}/${attempt}`,
      commit,
    },
    outcome,
  });
  const step = (id: string, attempts: [number, Attempt][]) => ({
    id,
    inputs: [],
    attempts: new Map(attempts),
  });
  // Brewed by plan at the base, then brew twice, each at the plan's tree; its task tree is the
  // branch of brew's second attempt.
  const brewed = (lane: Lane, effects: ReadonlyMap<string, unknown> = new Map()): State => ({
    ...emptyState,
    effects,
    batches: new Map([
      [
        '12-1',
        {
          ...batch('12-1', lane),
          steps: new Map([
            ['plan', step('plan', [[1, finished('plan', 1, BASE)]])],
            [
              'brew',
              step('brew', [
                [1, finished('brew', 1, TIP)],
                [2, finished('brew', 2, TIP)],
              ]),
            ],
          ]),
          taskTree: { kind: 'attempt', stepId: 'brew', attempt: 2, repo: 'acme/app' },
        },
      ],
    ]),
  });
  const pushedFrom = (from: string): ReadonlyMap<string, unknown> =>
    new Map([
      [
        effectKey.encode({ batchId: '12-1', effect: 'push' }),
        { branch: 'foedrum/acme.app/12-1/brew/2', commit: TIP, from },
      ],
    ]);

  it("names the branch of an ended batch's task tree, with the commit the batch started from", () => {
    for (const lane of [lanes['on-tap'], lanes.cancelled] as Lane[]) {
      assert.deepEqual(
        worktreeClaims(brewed(lane), []).unpushed,
        new Map([['foedrum/12-1/brew/2', BASE]]),
        lane.kind,
      );
    }
  });

  it('leaves it out once a push recorded it', () => {
    const state = brewed(lanes['on-tap'] as Lane, pushedFrom('refs/heads/foedrum/12-1/brew/2'));
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map());
  });

  it('names it when the push recorded another revision: the task tree moved since', () => {
    const state = brewed(lanes['on-tap'] as Lane, pushedFrom('refs/heads/foedrum/12-1/brew/1'));
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map([['foedrum/12-1/brew/2', BASE]]));
  });

  it('names it when the secret scan stopped the push: nothing reached the remote (ADR 0079)', () => {
    const from = 'refs/heads/foedrum/12-1/brew/2';
    const refused = new Map([
      [
        effectKey.encode({ batchId: '12-1', effect: 'push' }),
        {
          branch: 'foedrum/acme.app/12-1/brew/2',
          commit: TIP,
          from,
          refused: [{ commit: TIP, place: 'message', kind: 'GitHub token' }],
        },
      ],
    ]);
    const state = brewed(lanes.cancelled as Lane, refused);
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map([['foedrum/12-1/brew/2', BASE]]));
  });

  it('names nothing of a live batch, which keeps its branches anyway', () => {
    assert.deepEqual(worktreeClaims(brewed(lanes.brewing as Lane), []).unpushed, new Map());
  });

  it('starts the batch at its first attempt that succeeded, not at a failed one before the base moved (review of #230)', () => {
    const OLD = 'a'.repeat(40);
    const failed = finished('plan', 1, OLD, {
      kind: 'failed',
      retryable: true,
      reason: 'the run broke',
    });
    const state = brewed(lanes['on-tap'] as Lane);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    const steps = new Map(found.steps);
    steps.set(
      'plan',
      step('plan', [
        [1, failed],
        [2, finished('plan', 2, BASE)],
      ]),
    );
    const retried = { ...state, batches: new Map([['12-1', { ...found, steps }]]) };
    assert.deepEqual(
      worktreeClaims(retried, []).unpushed,
      new Map([['foedrum/12-1/brew/2', BASE]]),
    );
  });

  /** The on-tap batch of `brewed`, changed by `change`. */
  const changed = (change: (found: Batch) => Batch): State => {
    const state = brewed(lanes['on-tap'] as Lane);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    return { ...state, batches: new Map([['12-1', change(found)]]) };
  };

  it("takes the start in the task tree's repository, not another's (review of #230)", () => {
    const LIB = 'd'.repeat(40);
    const elsewhere = finished('plan', 1, LIB);
    assert.ok(elsewhere.phase === 'finished' && elsewhere.worktree !== undefined);
    const inLib = { ...elsewhere, worktree: { ...elsewhere.worktree, repo: 'acme/lib' } };
    const state = changed((found) => {
      const steps = new Map(found.steps);
      steps.set('plan', step('plan', [[1, inLib]]));
      steps.set(
        'brew',
        step('brew', [
          [1, finished('brew', 1, BASE)],
          [2, finished('brew', 2, TIP)],
        ]),
      );
      return { ...found, steps };
    });
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map([['foedrum/12-1/brew/2', BASE]]));
  });

  it("names nothing of a task tree rewound to the batch's start, which holds no commit past it (review of #230)", () => {
    const state = changed((found) => ({
      ...found,
      taskTree: { kind: 'rewound', shas: { 'acme/app': BASE } },
    }));
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map());
  });

  /** The batch of `brewed`, rewound to the plan's tree, cancelled, with `attempts` of brew. */
  const rewound = (attempts: [number, Attempt][], effects?: ReadonlyMap<string, unknown>) => {
    const state = brewed(lanes.cancelled as Lane, effects);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    const steps = new Map(found.steps);
    steps.set('brew', step('brew', attempts));
    const batch: Batch = {
      ...found,
      steps,
      taskTree: { kind: 'rewound', shas: { 'acme/app': TIP } },
    };
    return { ...state, batches: new Map([['12-1', batch]]) };
  };
  const failedAt = (attempt: number, commit: string) =>
    finished('brew', attempt, commit, { kind: 'failed', retryable: true, reason: 'the run broke' });

  it("names the branch of the latest attempt made at a rewound task tree's commit, with the batch's start (#255)", () => {
    const state = rewound([
      [1, finished('brew', 1, TIP)],
      [2, finished('brew', 2, TIP)],
      [3, failedAt(3, TIP)],
    ]);
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map([['foedrum/12-1/brew/3', BASE]]));
  });

  it('names the branch of an attempt before the rewind made at its commit, when none ran after it (#255)', () => {
    const state = rewound([
      [1, finished('brew', 1, TIP)],
      [2, finished('brew', 2, TIP)],
    ]);
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map([['foedrum/12-1/brew/2', BASE]]));
  });

  it("names nothing of a rewound task tree once a push recorded the rewind's commit (#255)", () => {
    const state = rewound([[1, finished('brew', 1, TIP)]], pushedFrom(TIP));
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map());
  });

  it("names it when the push recorded another revision than the rewind's commit (#255)", () => {
    const state = rewound(
      [[1, finished('brew', 1, TIP)]],
      pushedFrom('refs/heads/foedrum/12-1/brew/1'),
    );
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map([['foedrum/12-1/brew/1', BASE]]));
  });

  /** `rewound` without the plan step, so no attempt of the batch succeeded. */
  const noneSucceeded = (attempts: [number, Attempt][]): State => {
    const state = rewound(attempts);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    const steps = new Map(found.steps);
    steps.delete('plan');
    return { ...state, batches: new Map([['12-1', { ...found, steps }]]) };
  };

  it("names nothing of a task tree rewound to its first attempt's commit when none succeeded (#255)", () => {
    const state = noneSucceeded([
      [1, failedAt(1, TIP)],
      [2, failedAt(2, TIP)],
    ]);
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map());
  });

  it('names the branch of a rewound task tree past its first attempt, with no start when none succeeded (#255)', () => {
    const state = noneSucceeded([
      [1, failedAt(1, BASE)],
      [2, failedAt(2, TIP)],
    ]);
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map([['foedrum/12-1/brew/2', '']]));
  });

  it("names nothing of a task tree rewound to its first succeeded attempt's commit, not a failed one's before it (review of #288)", () => {
    const OLD = 'a'.repeat(40);
    const state = rewound([[1, finished('brew', 1, TIP)]]);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    const steps = new Map(found.steps);
    const failed = finished('plan', 1, OLD, {
      kind: 'failed',
      retryable: true,
      reason: 'the run broke',
    });
    steps.set(
      'plan',
      step('plan', [
        [1, failed],
        [2, finished('plan', 2, BASE)],
      ]),
    );
    const batch: Batch = {
      ...found,
      steps,
      taskTree: { kind: 'rewound', shas: { 'acme/app': BASE } },
    };
    assert.deepEqual(
      worktreeClaims({ ...state, batches: new Map([['12-1', batch]]) }, []).unpushed,
      new Map(),
    );
  });

  it("names nothing when no attempt wrote in the rewind's repository (review of #288)", () => {
    const elsewhere = failedAt(1, TIP);
    assert.ok(elsewhere.phase === 'finished' && elsewhere.worktree !== undefined);
    const inLib = { ...elsewhere, worktree: { ...elsewhere.worktree, repo: 'acme/lib' } };
    const state = noneSucceeded([[1, inLib]]);
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map());
  });

  it("goes on to the rewind's next repository when no attempt wrote in the first (review of #288)", () => {
    const OTHER = 'f'.repeat(40);
    const state = rewound([[1, finished('brew', 1, TIP)]]);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    const batch: Batch = {
      ...found,
      taskTree: { kind: 'rewound', shas: { 'acme/lib': OTHER, 'acme/app': TIP } },
    };
    assert.deepEqual(
      worktreeClaims({ ...state, batches: new Map([['12-1', batch]]) }, []).unpushed,
      new Map([['foedrum/12-1/brew/1', BASE]]),
    );
  });

  it("names every attempt branch of the repository when no attempt was made at the rewind's commit (review of #288)", () => {
    // brew/1 succeeded with tip Q; a rewind to Q (say, to retry an action step after it) makes
    // no worktree there. Which branch holds Q only git can tell, so each one is named.
    const Q = 'e'.repeat(40);
    const state = rewound([[1, finished('brew', 1, TIP)]]);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    const batch: Batch = { ...found, taskTree: { kind: 'rewound', shas: { 'acme/app': Q } } };
    assert.deepEqual(
      worktreeClaims({ ...state, batches: new Map([['12-1', batch]]) }, []).unpushed,
      new Map([
        ['foedrum/12-1/plan/1', BASE],
        ['foedrum/12-1/brew/1', BASE],
      ]),
    );
  });

  it('names the branch of a failed attempt whose work a rewind went back to (review of #288)', () => {
    // brew/2 started at the plan's tree, committed X and failed; the rewind names X, and no
    // worktree was made there before the batch was cancelled.
    const X = 'e'.repeat(40);
    const state = rewound([
      [1, finished('brew', 1, TIP)],
      [2, failedAt(2, TIP)],
    ]);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    const batch: Batch = { ...found, taskTree: { kind: 'rewound', shas: { 'acme/app': X } } };
    const unpushed = worktreeClaims({ ...state, batches: new Map([['12-1', batch]]) }, []).unpushed;
    assert.equal(unpushed?.get('foedrum/12-1/brew/2'), BASE);
  });

  it('names the branch of a step a loop went back to, whatever the order of the steps (review of #288)', () => {
    // plan/1 at the base, brew/1 at its tree, then plan/2 at brew's tree; the rewind names
    // plan/2's tip, at which no worktree was made: an action step came next.
    const P2 = 'e'.repeat(40);
    const state = rewound([[1, finished('brew', 1, TIP)]]);
    const found = state.batches.get('12-1');
    assert.ok(found !== undefined);
    const steps = new Map(found.steps);
    steps.set(
      'plan',
      step('plan', [
        [1, finished('plan', 1, BASE)],
        [2, finished('plan', 2, 'a'.repeat(40))],
      ]),
    );
    const batch: Batch = {
      ...found,
      steps,
      taskTree: { kind: 'rewound', shas: { 'acme/app': P2 } },
    };
    const unpushed = worktreeClaims({ ...state, batches: new Map([['12-1', batch]]) }, []).unpushed;
    assert.equal(unpushed?.get('foedrum/12-1/plan/2'), BASE);
  });

  it("keeps the branch holding a rewound task tree in the cleanup's plan, with ADR 0084's line (#255)", () => {
    const state = rewound([
      [1, finished('brew', 1, TIP)],
      [2, failedAt(2, TIP)],
    ]);
    const branches = ['plan/1', 'brew/1', 'brew/2'].map((attempt) => ({
      name: `foedrum/12-1/${attempt}`,
      tip: TIP,
    }));

    const plan = planClean(
      { worktrees: [], branches, folders: [] },
      worktreeClaims(state, []),
      '/work',
    );

    assert.deepEqual(plan, {
      actions: [
        { kind: 'delete-branch', branch: 'foedrum/12-1/plan/1', tip: TIP },
        { kind: 'delete-branch', branch: 'foedrum/12-1/brew/1', tip: TIP },
      ],
      kept: [
        'kept branch foedrum/12-1/brew/2: it holds the task tree of batch 12-1, which no push recorded (ADR 0084)',
      ],
    });
  });
});

describe('worktreeClaims: the start in the order of the events (#309)', () => {
  const [BASE, T1, I2, R4] = ['b', '1', '2', '4'].map((c) => c.repeat(40)) as [
    string,
    string,
    string,
    string,
  ];
  const at = '2026-10-15T13:00:00.000Z';
  const human = { by: 'octocat', via: 'terminal' } as const;
  const ran = (
    stepId: string,
    attempt: number,
    commit: string,
    outcome: Extract<Event, { type: 'step.finished' }>['outcome'],
  ): Event[] => [
    { type: 'step.scheduled', batchId: '2-1', stepId, attempt, deadlineAt: at },
    {
      type: 'step.started',
      batchId: '2-1',
      stepId,
      attempt,
      worktree: {
        repo: 'acme/app',
        path: `work/acme.app/attempts/2-1/${stepId}/${attempt}`,
        branch: `foedrum/2-1/${stepId}/${attempt}`,
        commit,
      },
    },
    { type: 'step.finished', batchId: '2-1', stepId, attempt, outcome },
  ];
  const succeeded = { kind: 'succeeded', output: {} } as const;
  const failed = { kind: 'failed', retryable: false, reason: 'blocked' } as const;
  const stuck = (stepId: string): Event => ({
    type: 'batch.stuck',
    batchId: '2-1',
    reason: { kind: 'attempts_exhausted', stepId, attempts: 1, lastReason: 'blocked' },
    options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
    remindAt: at,
  });
  const skip: Event = { type: 'batch.resumed', batchId: '2-1', action: 'skip', ...human };
  const growler = (source: 'router' | 'human'): Event =>
    source === 'human'
      ? {
          type: 'batch.recipe_chosen',
          batchId: '2-1',
          recipe: 'growler',
          reason: 'another recipe fits better',
          source,
          ...human,
        }
      : { type: 'batch.recipe_chosen', batchId: '2-1', recipe: 'growler', reason: 'label', source };
  // The run seed 136113810 shrank to: tests#1 failed at the base and was skipped, implement#1
  // succeeded there; a new recipe ran tests#2 at implement#1's tip and implement#2 after it.
  const brewed: Event[] = [
    { type: 'batch.ordered', batchId: '2-1', order: { issue: 2 }, routeBy: at },
    growler('router'),
    ...ran('tests', 1, BASE, failed),
    stuck('tests'),
    skip,
    ...ran('implement', 1, BASE, succeeded),
    ...ran('review', 1, T1, failed),
    stuck('review'),
    growler('human'),
    { type: 'batch.resumed', batchId: '2-1', action: 'recipe', ...human },
    ...ran('tests', 2, T1, succeeded),
    ...ran('implement', 2, I2, succeeded),
  ];
  const onTap: Event = {
    type: 'batch.on_tap',
    batchId: '2-1',
    pullRequests: ['https://github.com/acme/api/pull/7'],
  };

  it("names nothing of a task tree rewound to the batch's start after a new recipe ran an earlier step again", () => {
    const state = fold([
      ...brewed,
      ...ran('review', 2, R4, { kind: 'failed', retryable: true, reason: 'crash' }),
      ...ran('review', 3, R4, { kind: 'failed', retryable: true, reason: 'crash' }),
      stuck('review'),
      {
        type: 'batch.rewound',
        batchId: '2-1',
        toStepId: 'review',
        shas: { 'acme/app': BASE },
        ...human,
      },
      ...ran('review', 4, BASE, failed),
      stuck('review'),
      skip,
      onTap,
    ]);
    assert.deepEqual(worktreeClaims(state, []).unpushed, new Map());
  });

  it("names the task tree's branch with the commit of the first attempt that succeeded, not of the first step", () => {
    const state = fold([...brewed, onTap]);
    assert.deepEqual(
      worktreeClaims(state, []).unpushed,
      new Map([['foedrum/2-1/implement/2', BASE]]),
    );
  });
});
