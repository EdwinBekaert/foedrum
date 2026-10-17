import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Event,
  SessionRef,
  StuckReason,
  Surface,
  WaitCondition,
} from '../../src/schemas/events.ts';

const sha = 'a'.repeat(40);
const pullRequest = 'https://github.com/acme/lib-core/pull/7';
const question = {
  q: 'Keep the v1 endpoint?',
  options: ['keep', 'remove'],
  recommended: 'keep',
  whyBlocking: 'Removing it breaks the mobile app',
};
const session = {
  id: '3f2c9a1e-0b7d-4c55-9e1a-2d8f6b4c0a11',
  worktree: 'work/acme/batches/b1/lib-core',
  claudeVersion: '2.1.300',
};

const without = (value: object, key: string): unknown =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

// Typed as a record so that adding or removing an event type fails the typecheck until this list follows.
const valid: Record<Event['type'], Event> = {
  'batch.ordered': {
    type: 'batch.ordered',
    batchId: 'b2',
    order: { issue: 101 },
    routeBy: '2026-12-31T00:00:00.000Z',
    parentBatchId: 'b1',
  },
  'batch.recipe_chosen': {
    type: 'batch.recipe_chosen',
    batchId: 'b1',
    recipe: 'pint',
    reason: 'label size:pint',
    source: 'label',
  },
  'step.scheduled': {
    type: 'step.scheduled',
    batchId: 'b1',
    stepId: 'brew',
    attempt: 1,
    deadlineAt: '2026-10-15T12:00:00Z',
  },
  'step.started': { type: 'step.started', batchId: 'b1', stepId: 'brew', attempt: 1, session },
  'step.finished': {
    type: 'step.finished',
    batchId: 'b1',
    stepId: 'brew',
    attempt: 1,
    outcome: { kind: 'succeeded', output: null },
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: 400 },
  },
  'input.received': {
    type: 'input.received',
    batchId: 'b1',
    stepId: 'brew',
    by: 'octocat',
    via: 'comment',
    answers: [{ q: 'Keep the v1 endpoint?', answer: 'keep' }],
  },
  'batch.stuck': {
    type: 'batch.stuck',
    batchId: 'b1',
    reason: { kind: 'needs_input', stepId: 'brew', questions: [question] },
    options: ['answer', 'skip', 'cancel'],
    remindAt: '2026-10-17T10:00:00Z',
  },
  'batch.resumed': {
    type: 'batch.resumed',
    batchId: 'b1',
    by: 'octocat',
    via: 'plugin',
    action: 'answer',
  },
  'order.decomposed': {
    type: 'order.decomposed',
    batchId: 'b1',
    subOrders: [
      { issue: 101, repo: 'acme/lib-core' },
      { issue: 103, repo: 'acme/api' },
    ],
    dependencies: [{ subOrder: 103, blockedBy: 101, kind: 'release' }],
  },
  'batch.waiting': {
    type: 'batch.waiting',
    batchId: 'b3',
    on: { kind: 'release', repo: 'acme/lib-core', package: 'lib-core', minVersion: '2.4.0' },
    remindAt: '2026-10-17T12:00:00Z',
  },
  'bottle.opened': {
    type: 'bottle.opened',
    bottleId: 'A',
    repo: 'acme/lib-core',
    subOrders: [101, 102],
    pullRequest,
  },
  'release.observed': {
    type: 'release.observed',
    repo: 'acme/lib-core',
    package: 'lib-core',
    version: '2.4.0',
  },
  'batch.rewound': {
    type: 'batch.rewound',
    batchId: 'b1',
    toStepId: 'gauge',
    by: 'octocat',
    via: 'plugin',
    shas: { 'acme/lib-core': sha },
  },
  'batch.on_tap': { type: 'batch.on_tap', batchId: 'b1', pullRequests: [pullRequest] },
  'batch.cancelled': { type: 'batch.cancelled', batchId: 'b1', by: 'octocat', via: 'comment' },
  'pull_request.ended': {
    type: 'pull_request.ended',
    batchId: 'app-7',
    pullRequest,
    state: 'merged',
  },
  'effect.applied': {
    type: 'effect.applied',
    key: '["b1","brew",1,"pull_request"]',
    result: { number: 7 },
  },
};

const accepts = (
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } },
  value: unknown,
): void => {
  const result = schema.safeParse(value);
  assert.ok(result.success, `rejected: ${String(result.error)}`);
  assert.deepEqual(result.data, value);
};
const rejects = (
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
) => {
  assert.equal(schema.safeParse(value).success, false);
};

const threeSubOrders = {
  type: 'order.decomposed',
  batchId: 'b1',
  subOrders: [
    { issue: 101, repo: 'acme/lib-core' },
    { issue: 102, repo: 'acme/lib-core' },
    { issue: 103, repo: 'acme/api' },
  ],
};

describe('Event', () => {
  for (const [type, event] of Object.entries(valid)) {
    it(`accepts ${type}`, () => accepts(Event, event));
  }

  it('accepts optional fields left out', () => {
    accepts(Event, {
      type: 'batch.ordered',
      batchId: 'b1',
      order: { issue: 100 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });
    accepts(Event, { type: 'step.started', batchId: 'b1', stepId: 'gauge', attempt: 1 });
    accepts(Event, {
      type: 'step.finished',
      batchId: 'b1',
      stepId: 'brew',
      attempt: 2,
      outcome: { kind: 'cancelled' },
    });
  });

  it('accepts an order of a claimed issue in a target repository (ADR 0043)', () => {
    accepts(Event, {
      type: 'batch.ordered',
      batchId: 'app-7',
      order: { issue: 7, repo: 'acme/app' },
      routeBy: '2026-12-31T00:00:00.000Z',
    });
  });

  it('accepts a batch on tap without a pull request, as a recipe of brewer steps ends (ADR 0059)', () => {
    accepts(Event, { ...valid['batch.on_tap'], pullRequests: [] });
  });

  it('accepts a pull request that was closed without a merge', () => {
    accepts(Event, { ...valid['pull_request.ended'], state: 'closed' });
  });

  it('accepts a retry that sends a batch back to Ordered with a routing deadline', () => {
    accepts(Event, {
      ...valid['batch.resumed'],
      action: 'retry',
      routeBy: '2026-10-15T13:00:00Z',
    });
  });

  const invalid: [string, unknown][] = [
    ['an unknown type', { type: 'batch.brewed', batchId: 'b1' }],
    ['no type', { batchId: 'b1' }],
    ['an unknown field', { ...valid['batch.cancelled'], note: 'x' }],
    ['an empty batch id', { ...valid['batch.cancelled'], batchId: '' }],
    // Batch and step ids are path segments on the state branch (ADR 0024).
    ['an upper-case batch id', { ...valid['batch.cancelled'], batchId: 'B1' }],
    ['a batch id with a slash', { ...valid['batch.ordered'], batchId: 'a/b' }],
    ['a reserved batch id', { ...valid['batch.on_tap'], batchId: 'nul' }],
    ['an unsafe parent batch id', { ...valid['batch.ordered'], parentBatchId: '..' }],
    ['an unsafe step id', { ...valid['step.scheduled'], stepId: 'Plan' }],
    ['an unsafe step id in an answer', { ...valid['input.received'], stepId: 'a b' }],
    ['an unsafe rewind target', { ...valid['batch.rewound'], toStepId: 'plan/..' }],
    [
      'an unsafe step id in a stuck reason',
      { ...valid['batch.stuck'], reason: { kind: 'waiting_for_session', stepId: 'con' } },
    ],
    [
      'an unsafe sibling batch id',
      { ...valid['batch.waiting'], on: { kind: 'sibling', batchId: 'B2' } },
    ],
    [
      'an unsafe batch id in an effect key',
      { ...valid['effect.applied'], key: '["a/b","brew",1,"pr"]' },
    ],
    ['attempt 0', { ...valid['step.scheduled'], attempt: 0 }],
    ['a fractional attempt', { ...valid['step.scheduled'], attempt: 1.5 }],
    [
      'a deadline that is not an ISO timestamp',
      { ...valid['step.scheduled'], deadlineAt: 'tomorrow' },
    ],
    ['an unknown recipe chooser', { ...valid['batch.recipe_chosen'], source: 'model' }],
    ['an invalid outcome', { ...valid['step.finished'], outcome: { kind: 'done' } }],
    [
      'negative token usage',
      {
        ...valid['step.finished'],
        usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
    ['an unknown surface', { ...valid['input.received'], via: 'email' }],
    ['no answers', { ...valid['input.received'], answers: [] }],
    ['an unknown resume action', { ...valid['batch.resumed'], action: 'rewind' }],
    ['an unknown stuck option', { ...valid['batch.stuck'], options: ['retry', 'shrug'] }],
    ['an order without an issue number', { ...valid['batch.ordered'], order: {} }],
    [
      'an order without a routing deadline',
      { type: 'batch.ordered', batchId: 'b1', order: { issue: 100 } },
    ],
    ['a repository without an owner', { ...valid['release.observed'], repo: 'lib-core' }],
    ['a pull request that is not a URL', { ...valid['bottle.opened'], pullRequest: '#7' }],
    [
      'a pull request URL over http',
      { ...valid['bottle.opened'], pullRequest: 'http://github.com/acme/lib-core/pull/7' },
    ],
    ['a bottle without sub-orders', { ...valid['bottle.opened'], subOrders: [] }],
    ['an abbreviated sha', { ...valid['batch.rewound'], shas: { 'acme/lib-core': 'abc1234' } }],
    ['a pull request that ended open', { ...valid['pull_request.ended'], state: 'open' }],
    [
      'the end of a pull request that is no https URL',
      { ...valid['pull_request.ended'], pullRequest: 'http://github.com/acme/app/pull/7' },
    ],
    [
      'an order in a repository that is no owner/name',
      { ...valid['batch.ordered'], order: { issue: 7, repo: 'acme' } },
    ],
    [
      'an unknown dependency kind',
      {
        ...valid['order.decomposed'],
        dependencies: [{ subOrder: 103, blockedBy: 101, kind: 'soft' }],
      },
    ],
    [
      'a dependency on a sub-order not in the breakdown',
      {
        ...valid['order.decomposed'],
        dependencies: [{ subOrder: 103, blockedBy: 99, kind: 'code' }],
      },
    ],
    [
      'a dependency of a sub-order not in the breakdown',
      {
        ...valid['order.decomposed'],
        dependencies: [{ subOrder: 99, blockedBy: 101, kind: 'code' }],
      },
    ],
    [
      'a sub-order depending on itself',
      {
        ...valid['order.decomposed'],
        dependencies: [{ subOrder: 101, blockedBy: 101, kind: 'code' }],
      },
    ],
    [
      'a sub-order listed twice',
      {
        ...valid['order.decomposed'],
        subOrders: [
          { issue: 101, repo: 'acme/a' },
          { issue: 101, repo: 'acme/b' },
        ],
        dependencies: [],
      },
    ],
    [
      'a dependency cycle of two sub-orders',
      {
        ...threeSubOrders,
        dependencies: [
          { subOrder: 102, blockedBy: 101, kind: 'code' },
          { subOrder: 101, blockedBy: 102, kind: 'code' },
        ],
      },
    ],
    [
      'a dependency cycle of three sub-orders',
      {
        ...threeSubOrders,
        dependencies: [
          { subOrder: 102, blockedBy: 101, kind: 'code' },
          { subOrder: 103, blockedBy: 102, kind: 'release' },
          { subOrder: 101, blockedBy: 103, kind: 'code' },
        ],
      },
    ],
    ['batch.stuck without options', { ...valid['batch.stuck'], options: [] }],
    // Every command is recorded with who issued it and from where (ADR 0019).
    ['batch.cancelled without where it came from', without(valid['batch.cancelled'], 'via')],
    ['batch.rewound without where it came from', without(valid['batch.rewound'], 'via')],
    [
      'a human recipe choice without where it came from',
      {
        type: 'batch.recipe_chosen',
        batchId: 'b1',
        recipe: 'nip',
        reason: 'small',
        source: 'human',
        by: 'octocat',
      },
    ],
    [
      'a human recipe choice without who issued it',
      {
        type: 'batch.recipe_chosen',
        batchId: 'b1',
        recipe: 'nip',
        reason: 'small',
        source: 'human',
        via: 'terminal',
      },
    ],
    [
      'a human recipe choice with a blank issuer',
      {
        type: 'batch.recipe_chosen',
        batchId: 'b1',
        recipe: 'nip',
        reason: 'small',
        source: 'human',
        by: ' ',
        via: 'terminal',
      },
    ],
    [
      'a recipe choice by the router with an issuer',
      {
        type: 'batch.recipe_chosen',
        batchId: 'b1',
        recipe: 'nip',
        reason: 'small',
        source: 'router',
        by: 'octocat',
      },
    ],
    [
      'a recipe choice by the router with a surface',
      {
        type: 'batch.recipe_chosen',
        batchId: 'b1',
        recipe: 'nip',
        reason: 'small',
        source: 'router',
        via: 'plugin',
      },
    ],
    // A Stuck batch waits for a human with a reminder, never silently (ADR 0025).
    [
      'batch.stuck without a reminder',
      Object.fromEntries(
        Object.entries(valid['batch.stuck']).filter(([key]) => key !== 'remindAt'),
      ),
    ],
    ['a stuck option listed twice', { ...valid['batch.stuck'], options: ['retry', 'retry'] }],
    [
      'effect.applied without a result',
      { type: 'effect.applied', key: '["b1","brew",1,"pull_request"]' },
    ],
    ...[
      'b1/brew/1/pr',
      '["b1","brew",1]',
      '["b1","brew",0,"pull_request"]',
      '["b1", "brew", 1, "pull_request"]',
    ].map((key): [string, unknown] => [
      `the effect key ${key}`,
      { ...valid['effect.applied'], key },
    ]),
    [
      'step.finished with a succeeded outcome without output',
      { ...valid['step.finished'], outcome: { kind: 'succeeded' } },
    ],
    [
      'a pull request URL with credentials',
      { ...valid['bottle.opened'], pullRequest: 'https://token@github.com/acme/lib-core/pull/7' },
    ],
    ...[
      'HTTPS://token@github.com/acme/lib-core/pull/7',
      'https:\\\\token@github.com/acme/lib-core/pull/7',
      'https:/token@github.com/acme/lib-core/pull/7',
      'https://:secret@github.com/acme/lib-core/pull/7',
    ].map((pullRequest): [string, unknown] => [
      `the pull request URL ${pullRequest}`,
      { ...valid['bottle.opened'], pullRequest },
    ]),
    [
      'more than 100 sub-orders',
      {
        ...threeSubOrders,
        subOrders: Array.from({ length: 101 }, (_, i) => ({ issue: i + 1, repo: 'acme/api' })),
        dependencies: [],
      },
    ],
    [
      'more than 1000 dependencies',
      {
        ...threeSubOrders,
        dependencies: Array.from({ length: 1001 }, () => ({
          subOrder: 102,
          blockedBy: 101,
          kind: 'code',
        })),
      },
    ],
    ...['../..', 'acme/..', 'acme/.', './lib-core', '-acme/lib-core', 'acme/-lib-core'].map(
      (repo): [string, unknown] => [
        `the repository ${repo}`,
        { ...valid['release.observed'], repo },
      ],
    ),
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => rejects(Event, value));
  }

  it('accepts a human recipe choice with where it came from', () => {
    const chosen = {
      type: 'batch.recipe_chosen',
      batchId: 'b1',
      recipe: 'nip',
      reason: 'small',
      source: 'human',
      by: 'octocat',
      via: 'terminal',
    };
    assert.equal(Event.safeParse(chosen).success, true);
  });

  it('accepts a repository name starting with a dot', () => {
    accepts(Event, { ...valid['release.observed'], repo: 'acme/.github' });
  });

  it('accepts dependencies that form a chain, not a cycle', () => {
    accepts(Event, {
      ...threeSubOrders,
      dependencies: [
        { subOrder: 102, blockedBy: 101, kind: 'code' },
        { subOrder: 103, blockedBy: 102, kind: 'release' },
        { subOrder: 103, blockedBy: 101, kind: 'release' },
      ],
    });
  });
});

describe('SessionRef', () => {
  it('accepts a session, with or without the session it resumes', () => {
    accepts(SessionRef, session);
    accepts(SessionRef, { ...session, resumes: '0c1d2e3f-0000-4000-8000-000000000000' });
  });

  for (const field of ['id', 'worktree', 'claudeVersion'] as const) {
    it(`rejects a session without ${field}`, () =>
      rejects(SessionRef, { ...session, [field]: undefined }));
  }
  it('rejects an empty resumed session id', () => rejects(SessionRef, { ...session, resumes: '' }));
  it('rejects an unknown field', () => rejects(SessionRef, { ...session, model: 'opus' }));
});

describe('WorktreeRef', () => {
  const worktree = {
    repo: 'acme/app',
    path: 'work/acme.app/attempts/b1/plan/1',
    branch: 'foedrum/b1/plan/1',
    commit: 'a'.repeat(40),
  };
  const started = { type: 'step.started', batchId: 'b1', stepId: 'plan', attempt: 1 };

  it('is accepted in step.started', () => accepts(Event, { ...started, worktree }));
  it('rejects an unknown field', () =>
    rejects(Event, { ...started, worktree: { ...worktree, extra: 1 } }));
  it('rejects a commit that is not a full sha', () =>
    rejects(Event, { ...started, worktree: { ...worktree, commit: 'abc123' } }));
  it('rejects a repository that is no owner/name', () =>
    rejects(Event, { ...started, worktree: { ...worktree, repo: 'app' } }));
  for (const field of ['repo', 'path', 'branch', 'commit'] as const) {
    it(`rejects a worktree without ${field}`, () =>
      rejects(Event, { ...started, worktree: { ...worktree, [field]: undefined } }));
  }
});

describe('Surface', () => {
  it('is plugin, terminal, comment or dashboard', () => {
    for (const surface of ['plugin', 'terminal', 'comment', 'dashboard']) accepts(Surface, surface);
    rejects(Surface, 'email');
    rejects(Surface, 'Plugin');
  });
});

describe('StuckReason', () => {
  // Typed as a record so that adding or removing a kind fails the typecheck until this list follows.
  const reasons: Record<StuckReason['kind'], StuckReason> = {
    needs_input: { kind: 'needs_input', stepId: 'brew', questions: [question] },
    blocked: {
      kind: 'blocked',
      stepId: 'brew',
      blockerKind: 'environment',
      summary: 'No database',
    },
    attempts_exhausted: {
      kind: 'attempts_exhausted',
      stepId: 'brew',
      attempts: 3,
      lastReason: 'Out doc missing',
    },
    deadline_passed: {
      kind: 'deadline_passed',
      stepId: 'brew',
      deadlineAt: '2026-10-15T12:00:00Z',
    },
    waiting_for_session: { kind: 'waiting_for_session', stepId: 'analyze' },
    stalled: {
      kind: 'stalled',
      stepId: 'brew',
      lastProgressAt: '2026-10-15T12:00:00Z',
      turnsWithoutProgress: 60,
    },
    routing: { kind: 'routing', deadlineAt: '2026-10-15T12:00:00Z' },
  };
  for (const [kind, reason] of Object.entries(reasons)) {
    it(`accepts ${kind}`, () => accepts(StuckReason, reason));
  }

  it('rejects an unknown kind', () => rejects(StuckReason, { kind: 'bored', stepId: 'brew' }));
  it('rejects needs_input without questions', () =>
    rejects(StuckReason, { kind: 'needs_input', stepId: 'brew', questions: [] }));
  it('rejects blocked without a blocker kind', () =>
    rejects(StuckReason, { kind: 'blocked', stepId: 'brew', summary: 'x' }));
  it('rejects attempts_exhausted with zero attempts', () =>
    rejects(StuckReason, { ...reasons.attempts_exhausted, attempts: 0 }));
});

describe('WaitCondition', () => {
  // Typed as a record so that adding or removing a kind fails the typecheck until this list follows.
  const conditions: Record<WaitCondition['kind'], WaitCondition> = {
    merge: { kind: 'merge', pullRequest },
    release: { kind: 'release', repo: 'acme/lib-core', package: 'lib-core', minVersion: '2.4.0' },
    sibling: { kind: 'sibling', batchId: 'b2' },
  };
  for (const [kind, condition] of Object.entries(conditions)) {
    it(`accepts ${kind}`, () => accepts(WaitCondition, condition));
  }

  it('rejects an unknown kind', () => rejects(WaitCondition, { kind: 'ci', batchId: 'b2' }));
  it('rejects a release without a minimum version', () =>
    rejects(WaitCondition, { kind: 'release', repo: 'acme/lib-core', package: 'lib-core' }));
  it('rejects a merge without a pull request URL', () =>
    rejects(WaitCondition, { kind: 'merge', pullRequest: '' }));
});
