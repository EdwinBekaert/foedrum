// Out doc text on its way to the pull request body and the status comment (ADR 0088): a text that
// looks like a secret is left out, and the commits the state records for a batch are no keys.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { knownCommits, withoutSecrets } from '../../src/engine/out-doc-text.ts';
import type { Event } from '../../src/schemas/events.ts';

// Built at run time, so no scanner takes this file for one that holds a token.
const token = ['ghp', 'A1b2'.repeat(9)].join('_');
const none = () => false;
const leftOut = '[left out: a text of step brew that looks like a secret]';

describe('withoutSecrets', () => {
  it('keeps a text that looks like no secret as it is', () => {
    assert.equal(
      withoutSecrets('Added --json\nto the CLI', 'brew', none),
      'Added --json\nto the CLI',
    );
  });

  it('puts the fixed line naming the step in place of a text that looks like one', () => {
    const text = withoutSecrets(`Used ${token} to read the API`, 'brew', none);
    assert.equal(text, leftOut);
  });

  it('reads the text as it is shown too, on one line', () => {
    assert.equal(withoutSecrets('the password\n= hunter2', 'brew', none), leftOut);
  });

  it('keeps a commit hash that `isCommit` knows, and leaves out one it does not', () => {
    const sha = 'a'.repeat(40);
    assert.equal(
      withoutSecrets(`reverted ${sha}`, 'brew', (word) => word === sha),
      `reverted ${sha}`,
    );
    assert.equal(withoutSecrets(`reverted ${sha}`, 'brew', none), leftOut);
  });
});

describe('knownCommits', () => {
  const started = 'a'.repeat(40);
  const rewound = 'b'.repeat(40);
  const pushed = 'c'.repeat(40);
  const refused = 'd'.repeat(40);
  const elsewhere = 'e'.repeat(40);
  const events = (batchId: string, commit: string): Event[] => [
    { type: 'batch.ordered', batchId, order: { issue: 12 }, routeBy: '2026-12-31T00:00:00.000Z' },
    { type: 'batch.recipe_chosen', batchId, recipe: 'ale', reason: 'label', source: 'label' },
    {
      type: 'step.scheduled',
      batchId,
      stepId: 'brew',
      attempt: 1,
      deadlineAt: '2026-10-15T13:00:00.000Z',
    },
    {
      type: 'step.started',
      batchId,
      stepId: 'brew',
      attempt: 1,
      worktree: { repo: 'acme/api', path: '/work/brew/1', branch: 'foedrum/brew/1', commit },
    },
  ];
  const state = fold([
    ...events('12-1', started),
    ...events('13-1', elsewhere),
    {
      type: 'effect.applied',
      key: effectKey.encode({ batchId: '12-1', effect: 'push' }),
      result: {
        branch: 'foedrum/acme.brewery/12-1/acme.api',
        commit: pushed,
        from: 'refs/heads/foedrum/12-1/brew/1',
        refused: [{ commit: refused, place: 'notes.txt', kind: 'GitHub token' }],
      },
    },
  ]);
  const withRewind = fold([
    ...events('12-1', started),
    {
      type: 'batch.rewound',
      batchId: '12-1',
      toStepId: 'brew',
      by: 'alice',
      via: 'terminal',
      shas: { 'acme/api': rewound },
    },
  ]);

  it("knows the batch's worktree commits, and the commits its push recorded or refused", () => {
    const isCommit = knownCommits(state, '12-1');
    for (const sha of [started, pushed, refused]) assert.equal(isCommit(sha), true, sha);
  });

  it("knows the commits of the batch's rewinds", () => {
    assert.equal(knownCommits(withRewind, '12-1')(rewound), true);
  });

  it("knows no other batch's commits, nor any other word", () => {
    const isCommit = knownCommits(state, '12-1');
    assert.equal(isCommit(elsewhere), false);
    assert.equal(isCommit('f'.repeat(40)), false);
    assert.equal(knownCommits(state, '99-1')(started), false);
  });
});
