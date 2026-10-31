import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatReplay } from '../../src/cli/replay.ts';
import { fold } from '../../src/engine/fold.ts';
import {
  Event,
  MAX_HEAD_CHECK_URL_LENGTH,
  MAX_HEAD_CHECKS,
  PullRequestUrl,
  pullRequestOf,
  ScheduleRoute,
  SessionRef,
  StuckReason,
  Surface,
  WaitCondition,
} from '../../src/schemas/events.ts';
import { MAX_CONFLICTS } from '../../src/schemas/store.ts';

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
  'step.skipped': {
    type: 'step.skipped',
    batchId: 'b1',
    stepId: 'gauge',
    when: 'recipe.testFirst',
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
  'batch.taken_over': {
    type: 'batch.taken_over',
    batchId: 'b1',
    by: 'octocat',
    via: 'terminal',
    from: 'cellar',
    to: 'session-7',
    until: '2026-10-15T12:05:00.000Z',
  },
  'pull_request.ended': {
    type: 'pull_request.ended',
    batchId: 'app-7',
    pullRequest,
    state: 'merged',
  },
  'pull_request.base_checked': {
    type: 'pull_request.base_checked',
    batchId: 'app-7',
    pullRequest,
    branch: 'main',
    tip: 'c'.repeat(40),
    conflicts: ['src/app.ts'],
  },
  'pull_request.pair_checked': {
    type: 'pull_request.pair_checked',
    batchId: 'app-7',
    pullRequest,
    head: sha,
    other: 'https://github.com/acme/lib-core/pull/8',
    otherHead: 'b'.repeat(40),
    conflicts: ['src/app.ts'],
  },
  'pull_request.checks_pending': {
    type: 'pull_request.checks_pending',
    batchId: 'app-7',
    pullRequest,
    head: sha,
    since: '2026-10-26T09:00:00.000Z',
  },
  'pull_request.checks_finished': {
    type: 'pull_request.checks_finished',
    batchId: 'app-7',
    pullRequest,
    head: sha,
    checks: [
      {
        name: 'check (ubuntu-latest)',
        kind: 'check_run',
        conclusion: 'failure',
        url: 'https://github.com/acme/lib-core/actions/runs/1/job/2',
      },
      { name: 'ci/coverage', kind: 'status', conclusion: 'success' },
    ],
    more: 3,
  },
  'effect.applied': {
    type: 'effect.applied',
    key: '["b1","brew",1,"pull_request"]',
    result: { number: 7 },
  },
  'order.paused': {
    type: 'order.paused',
    order: { issue: 12 },
    by: 'ada',
    via: 'terminal',
    why: 'end of the day',
    stopAt: '2026-12-31T16:30:00.000Z',
    zone: 'Europe/Brussels',
  },
  'order.continued': { type: 'order.continued', by: 'ada', via: 'plugin' },
  'order.ranked': {
    type: 'order.ranked',
    order: { issue: 7, repo: 'acme/web' },
    place: { kind: 'position', position: 2, arrival: '2026-12-30T09:00:00.000Z', tie: 0.5 },
    by: 'ada',
    via: 'terminal',
    why: 'the release needs it',
  },
  'step.rescheduled': {
    type: 'step.rescheduled',
    batchId: 'b1',
    stepId: 'plan',
    attempt: 2,
    deadlineAt: '2026-12-31T17:30:00.000Z',
  },
  'usage.window_closed': {
    type: 'usage.window_closed',
    limit: 'weekly',
    resets: 'Mon 12:00am',
    reopensAt: '2027-01-03T23:05:00.000Z',
    read: true,
  },
  'usage.window_opened': { type: 'usage.window_opened', at: '2027-01-03T23:05:00.000Z' },
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

  it("accepts a check step's finish with its gravity readings (ADR 0069)", () => {
    const tail = `${'x'.repeat(3990)}\nnot ok 3\n`.slice(-4000);
    accepts(Event, {
      ...valid['step.finished'],
      outcome: { kind: 'failed', retryable: false, reason: 'the check "test" failed' },
      readings: [
        { result: 'skipped', check: 'typecheck' },
        { result: 'exited', check: 'lint', command: 'npm run lint', exitCode: 0, tail: '' },
        { result: 'exited', check: 'test', command: 'npm test', exitCode: 1, tail },
      ],
    });
    // A Brewery's literal command has no check name; Windows exit codes are unsigned.
    accepts(Event, {
      ...valid['step.finished'],
      readings: [{ result: 'exited', command: 'make e2e', exitCode: 3221225477, tail: 'boom' }],
    });
    for (const killed of ['timed-out', 'stopped', 'too-much-output'] as const) {
      accepts(Event, {
        ...valid['step.finished'],
        readings: [{ result: 'killed', check: 'test', command: 'npm test', killed, tail: '' }],
      });
    }
    accepts(Event, {
      ...valid['step.finished'],
      readings: [{ result: 'unstarted', check: 'build', command: 'cargo build', tail: 'ENOENT' }],
    });
  });

  it('accepts the reading of a check that a signal ended, and only with the signal', () => {
    const signaled = { result: 'signaled', check: 'test', command: 'node --test', tail: 'ok 1\n' };
    accepts(Event, { ...valid['step.finished'], readings: [{ ...signaled, signal: 'SIGSEGV' }] });
    rejects(Event, { ...valid['step.finished'], readings: [signaled] });
    rejects(Event, { ...valid['step.finished'], readings: [{ ...signaled, signal: '' }] });
  });

  it('rejects gravity readings that are empty, unbounded or not of a check', () => {
    const finished = (readings: unknown) => ({ ...valid['step.finished'], readings });
    const exited = { result: 'exited', check: 'test', command: 'npm test', exitCode: 1, tail: '' };
    rejects(Event, finished([]));
    rejects(Event, finished([{ ...exited, tail: 'x'.repeat(4001) }]));
    rejects(Event, finished([{ ...exited, check: 'e2e' }]));
    rejects(Event, finished([{ ...exited, command: '' }]));
    rejects(Event, finished([{ ...exited, exitCode: 1.5 }]));
    rejects(Event, finished([{ result: 'skipped' }]));
    rejects(Event, finished([{ result: 'passed', check: 'test' }]));
    rejects(Event, finished([{ ...exited, result: 'killed', killed: 'crashed' }]));
  });

  it('bounds the checks on a head and refuses a link that is not https (ADR 0213)', () => {
    const finished = valid['pull_request.checks_finished'];
    const check = { name: 'test', kind: 'check_run', conclusion: 'success' };
    accepts(Event, { ...finished, checks: [] });
    accepts(Event, { ...finished, checks: Array(MAX_HEAD_CHECKS).fill(check) });
    rejects(Event, { ...finished, checks: Array(MAX_HEAD_CHECKS + 1).fill(check) });
    accepts(Event, { ...finished, checks: [{ ...check, name: 'x'.repeat(200) }] });
    rejects(Event, { ...finished, checks: [{ ...check, name: 'x'.repeat(201) }] });
    rejects(Event, { ...finished, checks: [{ ...check, name: '' }] });
    rejects(Event, { ...finished, checks: [{ ...check, conclusion: 'pending' }] });
    rejects(Event, { ...finished, checks: [{ ...check, kind: 'suite' }] });
    rejects(Event, { ...finished, checks: [{ ...check, url: 'http://ci.example/1' }] });
    rejects(Event, { ...finished, checks: [{ ...check, url: 'https://u:p@ci.example/1' }] });
    const url = `https://ci.example/${'a'.repeat(MAX_HEAD_CHECK_URL_LENGTH - 19)}`;
    accepts(Event, { ...finished, checks: [{ ...check, url }] });
    rejects(Event, { ...finished, checks: [{ ...check, url: `${url}a` }] });
    rejects(Event, { ...finished, more: 0 });
    rejects(Event, { ...finished, head: 'main' });
    rejects(Event, { ...valid['pull_request.checks_pending'], since: 'yesterday' });
  });

  it('bounds a pair check of two open pull requests (ADR 0230)', () => {
    const paired = valid['pull_request.pair_checked'];
    accepts(Event, without(paired, 'conflicts'));
    accepts(Event, {
      ...paired,
      conflicts: Array.from({ length: MAX_CONFLICTS }, (_, i) => `f${i}`),
    });
    rejects(Event, { ...paired, conflicts: [] });
    rejects(Event, { ...paired, conflicts: [''] });
    rejects(Event, {
      ...paired,
      conflicts: Array.from({ length: MAX_CONFLICTS + 1 }, (_, i) => `f${i}`),
    });
    rejects(Event, { ...paired, otherHead: 'main' });
    rejects(Event, { ...paired, other: 'https://github.com/acme/lib-core/issues/8' });
    rejects(Event, without(paired, 'otherHead'));
  });

  it('accepts a rank marked first, and refuses a place it cannot sort by (ADR 0208)', () => {
    const ranked = valid['order.ranked'];
    const place = { kind: 'position', position: 2, arrival: '2026-12-30T09:00:00.000Z', tie: 0 };
    accepts(Event, { ...ranked, place: { kind: 'first' } });
    rejects(Event, { ...ranked, place: { kind: 'first', arrival: place.arrival } });
    rejects(Event, { ...ranked, place: { ...place, position: 0 } });
    rejects(Event, { ...ranked, place: { ...place, position: 1.5 } });
    rejects(Event, { ...ranked, place: { kind: 'position', position: 2 } });
    rejects(Event, { ...ranked, place: { ...place, arrival: 'yesterday' } });
    accepts(Event, { ...ranked, place });
    accepts(Event, { ...ranked, place: { ...place, tie: -1 } });
    rejects(Event, { ...ranked, place: without(place, 'tie') });
    rejects(Event, { ...ranked, place: { ...place, tie: 'x' } });
    rejects(Event, { ...ranked, place: { kind: 'last' } });
    rejects(Event, without(ranked, 'by'));
    rejects(Event, { ...ranked, why: '' });
  });

  it('accepts an attempt scheduled by an onFail or onBlocked route (ADR 0064)', () => {
    for (const why of ['failed', 'findings'] as const) {
      accepts(Event, { ...valid['step.scheduled'], route: { from: 'implement', why } });
    }
  });

  it('accepts an attempt scheduled as a retry, and refuses one marked false (ADR 0117)', () => {
    accepts(Event, { ...valid['step.scheduled'], retry: true });
    rejects(Event, { ...valid['step.scheduled'], retry: false });
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
    // Who ordered it by hand and from where are set together (ADR 0105).
    ['an order by a person from nowhere', { ...valid['batch.ordered'], by: 'ada' }],
    ['an order from a surface by nobody', { ...valid['batch.ordered'], via: 'terminal' }],
    ['an unsafe step id', { ...valid['step.scheduled'], stepId: 'Plan' }],
    ['an unsafe skipped step id', { ...valid['step.skipped'], stepId: '..' }],
    [
      'a route of another kind',
      { ...valid['step.scheduled'], route: { from: 'implement', why: 'environment' } },
    ],
    [
      'a route from an unsafe step id',
      { ...valid['step.scheduled'], route: { from: 'Implement', why: 'findings' } },
    ],
    [
      'a route with an unknown field',
      { ...valid['step.scheduled'], route: { from: 'implement', why: 'failed', rounds: 1 } },
    ],
    ['a skip without its when', without(valid['step.skipped'], 'when')],
    ['a skip with an empty when', { ...valid['step.skipped'], when: ' ' }],
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

  for (const field of ['id', 'worktree'] as const) {
    it(`rejects a session without ${field}`, () =>
      rejects(SessionRef, { ...session, [field]: undefined }));
  }
  it('rejects an empty resumed session id', () => rejects(SessionRef, { ...session, resumes: '' }));
  it('rejects an unknown field', () => rejects(SessionRef, { ...session, model: 'opus' }));
  // What claude reported goes on step.finished, once its init came (ADR 0116).
  it("rejects claude's version", () =>
    rejects(SessionRef, { ...session, claudeVersion: '2.1.300' }));
  // Why it started fresh where its brewer would have resumed (ADR 0117).
  it('accepts a fallback, and rejects an empty one', () => {
    accepts(SessionRef, { ...session, fallback: 'plan#1 has no session claude started' });
    rejects(SessionRef, { ...session, fallback: '' });
  });
});

describe("step.finished's claude (ADR 0116)", () => {
  const claude = { version: '2.1.301', model: 'claude-sonnet-5-5' };
  const finished = (value: unknown) => ({ ...valid['step.finished'], claude: value });

  it('accepts the version and the model claude reported, or neither', () => {
    accepts(Event, finished(claude));
    accepts(Event, valid['step.finished']);
  });
  for (const field of ['version', 'model'] as const) {
    it(`rejects claude without its ${field}, or with an empty one`, () => {
      rejects(Event, finished(without(claude, field)));
      rejects(Event, finished({ ...claude, [field]: '' }));
    });
  }
  it('rejects an unknown field', () => rejects(Event, finished({ ...claude, sessionId: 's1' })));
});

// An event recorded before ADR 0181 holds claude's cost: it still reads, without it.
describe("step.finished's receipt from before ADR 0181", () => {
  const tokens = { inputTokens: 2, outputTokens: 4, cacheReadTokens: 1670, cacheWriteTokens: 2452 };
  const receipt = { complete: true, turns: 1, edits: 0, toolErrors: 0, denied: [] };
  const model = { model: 'claude-haiku-5-5', ...tokens };
  const old = {
    ...valid['step.finished'],
    receipt: { ...receipt, costUsd: 0.82, models: [{ ...model, costUsd: 0.82 }] },
  };

  it('accepts its cost and a model cost, and drops both', () => {
    const parsed = Event.safeParse(old);
    assert.ok(parsed.success, String(parsed.error));
    assert.deepEqual(parsed.data, {
      ...valid['step.finished'],
      receipt: { ...receipt, models: [model] },
    });
  });

  // Review of #489: what the runner records now, with no cost at all.
  it('accepts a receipt and its models without a cost, as they are', () => {
    accepts(Event, { ...valid['step.finished'], receipt: { ...receipt, models: [model] } });
  });

  it('replays without its cost', () => {
    const ordered: Event = {
      type: 'batch.ordered',
      batchId: 'b1',
      order: { issue: 7 },
      routeBy: '2026-12-31T00:00:00.000Z',
    };
    const batch = fold([ordered]).batches.get('b1');
    assert.ok(batch);
    const text = formatReplay(batch, [{ id: 1, event: Event.parse(old) }]);
    assert.match(text, /"receipt":\{"complete":true,"turns":1,/);
    assert.doesNotMatch(text, /cost/i);
  });
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
    plan_review: { kind: 'plan_review', stepId: 'plan', attempt: 2 },
    stopped: { kind: 'stopped', stepId: 'brew', by: 'ada', via: 'terminal', why: 'lunch' },
    pull_request_failed: {
      kind: 'pull_request_failed',
      stepId: 'open-pull-request',
      pullRequest: 'https://github.com/acme/api/pull/12',
      head: 'c'.repeat(40),
      rounds: 2,
      failed: [{ name: 'ci / test', conclusion: 'failure' }],
      more: 0,
    },
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
  it('accepts stopped without a reason, and rejects it without who stopped it', () => {
    accepts(StuckReason, { kind: 'stopped', stepId: 'brew', by: 'ada', via: 'plugin' });
    rejects(StuckReason, { kind: 'stopped', stepId: 'brew', via: 'plugin' });
  });
});

describe('PullRequestUrl and pullRequestOf', () => {
  it('reads the repository and number of a pull request URL', () => {
    accepts(PullRequestUrl, 'https://github.com/o/n/pull/5');
    assert.deepEqual(pullRequestOf('https://github.com/o/n/pull/5'), { repo: 'o/n', number: 5 });
    assert.deepEqual(pullRequestOf('https://github.com/acme/lib.core-2/pull/120'), {
      repo: 'acme/lib.core-2',
      number: 120,
    });
  });

  const refused: [string, string][] = [
    ['a trailing slash', 'https://github.com/o/n/pull/5/'],
    ['number 0', 'https://github.com/o/n/pull/0'],
    ['a number with a leading zero', 'https://github.com/o/n/pull/05'],
    ['an issue', 'https://github.com/o/n/issues/5'],
    ['an owner that starts with -', 'https://github.com/-x/n/pull/5'],
    ['a name ..', 'https://github.com/o/../pull/5'],
    ['a name .', 'https://github.com/o/./pull/5'],
    ['another path', 'https://github.com/o/n/pull/5/files'],
    ['no repository', 'https://github.com/pull/5'],
    ['a query', 'https://github.com/o/n/pull/5?tab=files'],
    ['a fragment', 'https://github.com/o/n/pull/5#issuecomment-1'],
    ['http', 'http://github.com/o/n/pull/5'],
    ['credentials', 'https://token@github.com/o/n/pull/5'],
    ['a password only', 'https://:pw@github.com/o/n/pull/5'],
    ['a URL the parser writes otherwise', 'HTTPS://github.com/o/n/pull/5'],
    ['a URL with one slash after the scheme', 'https:/github.com/o/n/pull/5'],
    ['no URL', 'not a url'],
  ];
  for (const [what, url] of refused) {
    it(`refuses ${what}: ${url}`, () => {
      rejects(PullRequestUrl, url);
      assert.throws(() => pullRequestOf(url), /is not a pull request URL/);
    });
  }

  it("still takes a check run's link as a check's url", () => {
    const finished = valid['pull_request.checks_finished'];
    const check = { name: 'test', kind: 'check_run', conclusion: 'failure' };
    for (const url of [
      'https://github.com/acme/lib-core/actions/runs/1/job/2',
      'https://github.com/acme/lib-core/runs/42?check_suite_focus=true',
      'https://ci.example/build/7/',
    ]) {
      accepts(Event, { ...finished, checks: [{ ...check, url }] });
    }
  });
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

describe("ScheduleRoute's merged-tree cause (ADR 0226)", () => {
  const route = { from: 'open-pull-request', why: 'pull_request', pullRequest, head: sha };
  const tip = 'b'.repeat(40);

  it('takes a pull-request route with both its cause and tip, or neither', () => {
    assert.equal(ScheduleRoute.safeParse(route).success, true);
    assert.equal(ScheduleRoute.safeParse({ ...route, cause: 'merged_check', tip }).success, true);
  });

  it('refuses a cause without its tip, and a tip without its cause', () => {
    assert.equal(ScheduleRoute.safeParse({ ...route, cause: 'merged_check' }).success, false);
    assert.equal(ScheduleRoute.safeParse({ ...route, tip }).success, false);
  });
});
