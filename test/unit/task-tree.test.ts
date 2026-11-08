import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Attempt, Batch, Step, TaskTree } from '../../src/engine/fold.ts';
import { attemptStart, taskTreeStart } from '../../src/engine/task-tree.ts';

const repository = { repo: 'acme/app', base: 'origin/main' };
const batchWith = (taskTree?: TaskTree): Batch => ({
  id: 'b1',
  issue: 1,
  lane: { kind: 'brewing' },
  steps: new Map(),
  rewinds: [],
  ...(taskTree === undefined ? {} : { taskTree }),
});
const sha = 'd'.repeat(40);

describe('taskTreeStart (ADR 0066)', () => {
  it('starts at the base while the batch has no task tree', () => {
    assert.equal(taskTreeStart(batchWith(), repository), 'origin/main');
  });

  it("starts at the branch of the task tree's attempt, built from the attempt", () => {
    const tree = { kind: 'attempt', stepId: 'plan', attempt: 2, repo: 'Acme/App' } as const;
    assert.equal(taskTreeStart(batchWith(tree), repository), 'refs/heads/foedrum/b1/plan/2');
  });

  it("starts at a rewind's commit of the batch's repository, its name in any case", () => {
    const tree = {
      kind: 'rewound',
      shas: { 'acme/lib': 'e'.repeat(40), 'ACME/app': sha },
    } as const;
    assert.equal(taskTreeStart(batchWith(tree), repository), sha);
  });

  it('throws for a task tree in another repository, and a rewind that names no commit of it', () => {
    const elsewhere = { kind: 'attempt', stepId: 'plan', attempt: 1, repo: 'acme/lib' } as const;
    assert.throws(
      () => taskTreeStart(batchWith(elsewhere), repository),
      /^Error: the task tree of batch b1 is in acme\/lib, not acme\/app$/,
    );
    const rewound = { kind: 'rewound', shas: { 'acme/lib': sha } } as const;
    assert.throws(
      () => taskTreeStart(batchWith(rewound), repository),
      /^Error: the rewind of batch b1 names no commit of acme\/app$/,
    );
  });
});

describe('attemptStart (ADR 0358)', () => {
  const worktree = (stepId: string, attempt: number, repo = 'acme/app') => ({
    repo,
    path: `work/${stepId}/${attempt}`,
    branch: `foedrum/b1/${stepId}/${attempt}`,
    commit: sha,
  });
  const done = (stepId: string, attempt: number, more: Partial<Attempt> = {}): Attempt =>
    ({
      phase: 'finished',
      attempt,
      deadlineAt: '2026-11-08T12:00:00.000Z',
      worktree: worktree(stepId, attempt),
      outcome: { kind: 'succeeded', output: null },
      ...more,
    }) as Attempt;
  const failed = (stepId: string, attempt: number): Attempt =>
    done(stepId, attempt, { outcome: { kind: 'failed', retryable: true, reason: 'no' } });
  const stepOf = (id: string, attempts: readonly Attempt[]): [string, Step] => [
    id,
    { id, attempts: new Map(attempts.map((each) => [each.attempt, each])), inputs: [] },
  ];
  /** gauge#1 and implement#1 succeeded, then green#1 failed: the task tree holds the code. */
  const brewed = (more: Partial<Batch> = {}, gauge: readonly Attempt[] = [done('gauge', 1)]) => ({
    ...batchWith({ kind: 'attempt', stepId: 'implement', attempt: 1, repo: 'acme/app' }),
    steps: new Map([
      stepOf('gauge', gauge),
      stepOf('implement', [done('implement', 1)]),
      stepOf('green', [failed('green', 1)]),
    ]),
    path: [
      ...gauge.map(({ attempt }) => ({ stepId: 'gauge', attempt })),
      { stepId: 'implement', attempt: 1 },
      { stepId: 'green', attempt: 1 },
    ],
    ...more,
  });
  const atImplement = 'refs/heads/foedrum/b1/implement/1';

  it("starts the step a red proof proves at its own latest success, before the later steps' commits", () => {
    const gauge = [done('gauge', 1), failed('gauge', 2), done('gauge', 3)];
    assert.equal(
      attemptStart(brewed({}, gauge), 'gauge', repository, true),
      'refs/heads/foedrum/b1/gauge/3',
    );
  });

  it('starts any other step at the task tree', () => {
    assert.equal(attemptStart(brewed(), 'gauge', repository, false), atImplement);
  });

  it('starts the proven step at the task tree while it has no success', () => {
    assert.equal(
      attemptStart(brewed({}, [failed('gauge', 1)]), 'gauge', repository, true),
      atImplement,
    );
  });

  it('starts the proven step at the task tree when its success came before the latest rewind or recipe choice', () => {
    assert.equal(attemptStart(brewed({ runFrom: 1 }), 'gauge', repository, true), atImplement);
  });

  it('starts the proven step at a success that is the first attempt of the current run', () => {
    const batch = brewed();
    const path = [{ stepId: 'implement', attempt: 1 }, ...(batch.path ?? [])];
    assert.equal(
      attemptStart({ ...batch, path, runFrom: 1 }, 'gauge', repository, true),
      'refs/heads/foedrum/b1/gauge/1',
    );
  });

  it('starts the proven step at the task tree once an open pull request sent the batch back', () => {
    const route = {
      from: 'open',
      why: 'pull_request',
      pullRequest: 'https://github.com/acme/app/pull/7',
      head: sha,
    } as const;
    const batch = brewed();
    const sent = {
      ...batch,
      steps: new Map([
        ...batch.steps,
        stepOf('implement', [done('implement', 1), done('implement', 2, { route })]),
      ]),
    };
    assert.equal(attemptStart(sent, 'gauge', repository, true), atImplement);
  });

  it('starts the proven step at the task tree when its success wrote in another repository', () => {
    const elsewhere = done('gauge', 1, { worktree: worktree('gauge', 1, 'acme/lib') });
    assert.equal(attemptStart(brewed({}, [elsewhere]), 'gauge', repository, true), atImplement);
  });
});

describe('attemptStart of a resumed success (ADR 0358, ADR 0117)', () => {
  it('starts at the branch of the worktree the resumed session ran in', () => {
    const sha = 'd'.repeat(40);
    const session = { id: 's1', worktree: 'work/gauge/1' };
    const first = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: '2026-11-08T12:00:00.000Z',
      session,
      worktree: {
        repo: 'acme/app',
        path: 'work/gauge/1',
        branch: 'foedrum/b1/gauge/1',
        commit: sha,
      },
      outcome: { kind: 'failed', retryable: true, reason: 'turns ran out' },
    } as const;
    const resumed = {
      phase: 'finished',
      attempt: 2,
      deadlineAt: '2026-11-08T12:00:00.000Z',
      session: { id: 's1', resumes: 's1', worktree: 'work/gauge/1' },
      outcome: { kind: 'succeeded', output: null },
    } as const;
    const batch: Batch = {
      ...batchWith({ kind: 'attempt', stepId: 'implement', attempt: 1, repo: 'acme/app' }),
      steps: new Map([
        [
          'gauge',
          {
            id: 'gauge',
            attempts: new Map<number, Attempt>([
              [1, first],
              [2, resumed],
            ]),
            inputs: [],
          },
        ],
      ]),
    };
    assert.equal(attemptStart(batch, 'gauge', repository, true), 'refs/heads/foedrum/b1/gauge/1');
  });
});
