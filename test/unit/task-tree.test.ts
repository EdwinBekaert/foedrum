import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Batch, TaskTree } from '../../src/engine/fold.ts';
import { taskTreeStart } from '../../src/engine/task-tree.ts';

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
