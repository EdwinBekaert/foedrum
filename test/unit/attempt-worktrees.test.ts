import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type AttemptFacts,
  type AttemptRef,
  attemptBranch,
  attemptFolder,
  type BranchFact,
  type Claims,
  type Facts,
  type ListedFact,
  parseAttemptBranch,
  parseAttemptFolder,
  planClean,
  planWorktree,
  remoteBranch,
  repoFolder,
} from '../../src/workspace/attempt-worktrees.ts';

const ref = (batchId: string, stepId = 'implement', attempt = 1): AttemptRef => ({
  batchId,
  stepId,
  attempt,
});

describe('repoFolder', () => {
  it('is owner.name in lower case', () => {
    assert.equal(repoFolder('Acme/Web.App'), 'acme.web.app');
    assert.equal(repoFolder('acme/.github'), 'acme..github');
  });

  it('refuses a repository whose folder would not be one safe path segment', () => {
    for (const repo of ['acme', 'acme/x/y', 'acme/app-', 'con/app', `acme/${'a'.repeat(64)}`]) {
      assert.throws(() => repoFolder(repo), /repository/i, repo);
    }
  });
});

describe('remoteBranch', () => {
  it('pushes foedrum/<rest> as foedrum/<brewery>/<rest>, the Brewery as owner.name in lower case', () => {
    assert.equal(
      remoteBranch('Alice/Brewery', 'foedrum/12-1/bottle'),
      'foedrum/alice.brewery/12-1/bottle',
    );
    assert.equal(
      remoteBranch('alice/brewery', attemptBranch(ref('12-1', 'implement', 2))),
      'foedrum/alice.brewery/12-1/implement/2',
    );
  });

  it('gives two Breweries different branches for the same batch (ADR 0043)', () => {
    assert.notEqual(
      remoteBranch('alice/brewery', 'foedrum/12-1/bottle'),
      remoteBranch('bob/brewery', 'foedrum/12-1/bottle'),
    );
  });

  it('refuses a branch outside foedrum/ and a Brewery that is no part of a branch name', () => {
    const invalid: [string, string][] = [
      ['alice/brewery', 'main'],
      ['alice/brewery', 'foedrum/'],
      ['alice/brewery', 'foedrumx/12-1/bottle'],
      ['acme/.github', 'foedrum/12-1/bottle'],
      ['alice/x.lock', 'foedrum/12-1/bottle'],
      ['alice', 'foedrum/12-1/bottle'],
    ];
    for (const [brewery, local] of invalid) {
      assert.throws(() => remoteBranch(brewery, local), /branch|Brewery|repository/i, local);
    }
  });
});

describe('attemptBranch and attemptFolder', () => {
  it('name an attempt by batch, step and attempt number', () => {
    assert.equal(attemptBranch(ref('12-1', 'implement', 3)), 'foedrum/12-1/implement/3');
    assert.equal(attemptFolder(ref('12-1', 'implement', 3)), '12-1/implement/3');
  });

  it('round-trip through their parsers', () => {
    const attempt = ref('12-1', 'write.tests', 10);
    assert.deepEqual(parseAttemptBranch(attemptBranch(attempt)), attempt);
    assert.deepEqual(parseAttemptFolder(attemptFolder(attempt)), attempt);
  });

  it('refuse ids that are no path segment or no part of a git branch name', () => {
    const invalid: AttemptRef[] = [
      ref('B1'),
      ref('12-1', 'Implement'),
      ref('nul'),
      ref('12-1', 'implement', 0),
      ref('12-1', 'implement', 1.5),
      // Path segments, but not in a branch name: `..` and a `.lock` ending.
      ref('a..b'),
      ref('12-1', 'x.lock'),
      // foedrum/state is the state branch, so foedrum/state/… cannot exist.
      ref('state'),
    ];
    for (const attempt of invalid) {
      assert.throws(() => attemptBranch(attempt), /attempt/i, JSON.stringify(attempt));
      assert.throws(() => attemptFolder(attempt), /attempt/i, JSON.stringify(attempt));
    }
  });

  it('parse nothing but the canonical name of a valid attempt', () => {
    for (const name of [
      'main',
      'foedrum/state',
      'foedrum/12-1/bottle',
      'foedrum/12-1/implement/03',
      'foedrum/12-1/implement/3/x',
      'foedrum/state/implement/3',
      'foedrum/12-1/x.lock/3',
      'other/12-1/implement/3',
    ]) {
      assert.equal(parseAttemptBranch(name), undefined, name);
    }
    for (const inside of ['12-1', '12-1/implement', '12-1/implement/03', '12-1/implement/3/x']) {
      assert.equal(parseAttemptFolder(inside), undefined, inside);
    }
  });
});

const root = join('/work', 'acme.app', 'attempts');
const tipOf = (name: string): string => `tip-of-${name}`;

const listed = (attempt: AttemptRef, fact: Partial<ListedFact> = {}): ListedFact => ({
  path: join(root, attemptFolder(attempt)),
  inside: attemptFolder(attempt),
  branch: attemptBranch(attempt),
  lockReason: undefined,
  state: 'clean',
  record: `/repo/.git/worktrees/${attempt.stepId}${attempt.attempt}`,
  ...fact,
});

const branchFact = (name: string): BranchFact => ({ name, tip: tipOf(name) });

// Every listed attempt worktree's branch exists, and so does every batch folder.
const facts = (worktrees: ListedFact[], more: Partial<Facts> = {}): Facts => {
  const inRoot = worktrees.filter((worktree) => worktree.inside !== undefined);
  const batches = new Set(inRoot.map((worktree) => worktree.inside?.split('/')[0] ?? ''));
  return {
    worktrees,
    branches: worktrees.flatMap((worktree) =>
      worktree.branch === undefined ? [] : [branchFact(worktree.branch)],
    ),
    folders: [...batches].map((batchId) => ({
      batchId,
      attempts: inRoot
        .filter((worktree) => worktree.inside?.startsWith(`${batchId}/`))
        .map((worktree) => worktree.inside?.split('/').slice(1).join('/') ?? ''),
    })),
    ...more,
  };
};

const claims = (batches: Record<string, 'live' | 'ended'>, leased: AttemptRef[] = []): Claims => ({
  batches: new Map(Object.entries(batches)),
  leased,
});

describe('planClean', () => {
  const ended = ref('12-1');
  const branchOf = (attempt: AttemptRef): BranchFact => branchFact(attemptBranch(attempt));

  it('removes the worktree, the batch folder and the branch of an ended batch', () => {
    const worktree = listed(ended);

    const plan = planClean(facts([worktree]), claims({ '12-1': 'ended' }), root);

    assert.deepEqual(plan, {
      actions: [
        {
          kind: 'remove',
          label: '12-1/implement/1',
          path: worktree.path,
          record: worktree.record,
          branch: branchOf(ended),
        },
        { kind: 'remove-batch-folder', label: '12-1', path: join(root, '12-1') },
      ],
      kept: [],
    });
  });

  it('removes the clean worktree of an unknown batch but keeps its branch: its commits may be the only copy', () => {
    const worktree = listed(ended);

    const plan = planClean(facts([worktree]), claims({}), root);

    assert.deepEqual(plan.actions[0], {
      kind: 'remove',
      label: '12-1/implement/1',
      path: worktree.path,
      record: worktree.record,
      branch: undefined,
    });
    assert.ok(!plan.actions.some((action) => action.kind === 'delete-branch'));
    assert.deepEqual(plan.kept, [
      'kept branch foedrum/12-1/implement/1: no batch 12-1 in this Brewery',
    ]);
  });

  it('removes a folder git does not know of a batch the state does not know', () => {
    const folders = [{ batchId: '99-1', attempts: ['implement/1'] }];

    const plan = planClean({ worktrees: [], branches: [], folders }, claims({}), root);

    assert.deepEqual(
      plan.actions.map((action) => ('label' in action ? `${action.kind} ${action.label}` : '')),
      ['remove-folder 99-1/implement/1', 'remove-batch-folder 99-1'],
    );
  });

  it('keeps a locked stale record below an attempt folder: its drive may only be away', () => {
    const stale = listed(ref('12-1', 'c'), {
      path: join(root, '12-1', 'c', '1', 'sub'),
      inside: '12-1/c/1/sub',
      branch: undefined,
      state: 'gone',
      lockReason: 'on a removable drive',
    });

    const plan = planClean(
      { worktrees: [stale], branches: [], folders: [] },
      claims({ '12-1': 'ended' }),
      root,
    );

    assert.deepEqual(plan, {
      actions: [],
      kept: ['kept worktree 12-1/c/1/sub: locked: on a removable drive'],
    });
  });

  it('keeps a stale record below an attempt folder of a live batch', () => {
    const stale = listed(ref('12-1', 'c'), {
      path: join(root, '12-1', 'c', '1', 'sub'),
      inside: '12-1/c/1/sub',
      branch: undefined,
      state: 'gone',
    });

    const plan = planClean(
      { worktrees: [stale], branches: [], folders: [] },
      claims({ '12-1': 'live' }),
      root,
    );

    assert.deepEqual(plan, {
      actions: [],
      kept: ['kept worktree 12-1/c/1/sub: not an attempt folder'],
    });
  });

  it('removes the worktree of a batch the state does not know: the attempts root is ours', () => {
    const plan = planClean(facts([listed(ended)]), claims({}), root);

    assert.deepEqual(
      plan.actions.map((action) => action.kind),
      ['remove', 'remove-batch-folder'],
    );
  });

  it('keeps a live batch without a word, and clears a stale index.lock of a worktree no attempt runs in', () => {
    const worktree = listed(ref('12-1'));

    const plan = planClean(facts([worktree]), claims({ '12-1': 'live' }), root);

    assert.deepEqual(plan, {
      actions: [{ kind: 'index-lock', label: '12-1/implement/1', gitDir: worktree.record ?? '' }],
      kept: [],
    });
  });

  it('never removes a worktree with a live lease, nor touches its index.lock or branch', () => {
    const running = ref('12-1', 'implement', 2);
    const worktrees = [listed(running)];

    const endedPlan = planClean(facts(worktrees), claims({ '12-1': 'ended' }, [running]), root);
    const livePlan = planClean(facts(worktrees), claims({ '12-1': 'live' }, [running]), root);

    assert.deepEqual(endedPlan, {
      actions: [],
      kept: ['kept worktree 12-1/implement/2: its attempt holds a live lease'],
    });
    assert.deepEqual(livePlan, { actions: [], kept: [] });
  });

  it('keeps and reports a worktree with changes, a locked one and one that holds another', () => {
    const dirty = listed(ref('12-1', 'a'), { state: 'dirty' });
    const locked = listed(ref('12-1', 'b'), { lockReason: 'on a removable drive' });
    const outer = listed(ref('12-1', 'c'));
    const nested = listed(ref('12-1', 'c'), {
      path: join(outer.path, 'sub'),
      inside: '12-1/c/1/sub',
      branch: undefined,
    });

    const plan = planClean(
      facts([dirty, locked, outer, nested]),
      claims({ '12-1': 'ended' }),
      root,
    );

    assert.deepEqual(plan.kept, [
      'kept worktree 12-1/a/1: it has uncommitted or untracked changes',
      'kept worktree 12-1/b/1: locked: on a removable drive',
      'kept worktree 12-1/c/1: it contains the worktree 12-1/c/1/sub',
      'kept worktree 12-1/c/1/sub: not an attempt folder',
    ]);
    // Nothing goes, but the stale index.lock of every kept attempt worktree may; a branch
    // checked out in a kept worktree stays, and so does the batch folder.
    assert.deepEqual(
      plan.actions.map((action) => ('label' in action ? `${action.kind} ${action.label}` : '')),
      ['index-lock 12-1/a/1', 'index-lock 12-1/b/1', 'index-lock 12-1/c/1'],
    );
  });

  it('prunes a record whose folder is gone and finishes a removal that stopped part-way', () => {
    const gone = listed(ref('12-1', 'a'), { state: 'gone' });
    const noGit = listed(ref('12-1', 'b'), { state: 'no-git' });

    const plan = planClean(facts([gone, noGit]), claims({ '12-1': 'ended' }), root);

    assert.deepEqual(plan.actions, [
      {
        kind: 'prune',
        label: '12-1/a/1',
        record: gone.record,
        branch: branchFact(gone.branch ?? ''),
      },
      {
        kind: 'finish',
        label: '12-1/b/1',
        path: noGit.path,
        record: noGit.record,
        branch: branchFact(noGit.branch ?? ''),
      },
      { kind: 'remove-batch-folder', label: '12-1', path: join(root, '12-1') },
    ]);
  });

  it('removes a folder git does not know, unless its batch is live or its attempt leased', () => {
    const folders = [
      { batchId: '12-1', attempts: ['implement/1'] },
      { batchId: '13-1', attempts: ['implement/1'] },
      { batchId: '14-1', attempts: ['implement/1', 'stray'] },
    ];
    const state = claims({ '12-1': 'ended', '13-1': 'live', '14-1': 'ended' }, [ref('14-1')]);

    const plan = planClean({ worktrees: [], branches: [], folders }, state, root);

    assert.deepEqual(plan.actions, [
      {
        kind: 'remove-folder',
        label: '12-1/implement/1',
        path: join(root, '12-1', 'implement', '1'),
      },
      { kind: 'remove-batch-folder', label: '12-1', path: join(root, '12-1') },
    ]);
    assert.deepEqual(plan.kept, [
      'kept folder 14-1/implement/1: its attempt holds a live lease',
      'kept folder 14-1/stray: not an attempt folder',
    ]);
  });

  it('deletes the branches of an ended batch, and only those', () => {
    const branches = [
      'foedrum/12-1/implement/1',
      // The local copy of a pushed bottle branch goes too.
      'foedrum/12-1/bottle',
      'foedrum/13-1/implement/1',
      'foedrum/state',
      'main',
    ].map(branchFact);

    const plan = planClean(
      { worktrees: [], branches, folders: [] },
      claims({ '12-1': 'ended', '13-1': 'live' }),
      root,
    );

    assert.deepEqual(plan, {
      actions: [
        {
          kind: 'delete-branch',
          branch: 'foedrum/12-1/implement/1',
          tip: 'tip-of-foedrum/12-1/implement/1',
        },
        { kind: 'delete-branch', branch: 'foedrum/12-1/bottle', tip: 'tip-of-foedrum/12-1/bottle' },
      ],
      kept: [],
    });
  });

  it('keeps the branch of a batch it does not know: another Brewery may share the clone', () => {
    const branches = [branchFact('foedrum/99-1/implement/1')];

    const plan = planClean({ worktrees: [], branches, folders: [] }, claims({}), root);

    assert.deepEqual(plan, {
      actions: [],
      kept: ['kept branch foedrum/99-1/implement/1: no batch 99-1 in this Brewery'],
    });
  });

  it('keeps a branch checked out outside the attempts root, and never looks at that worktree', () => {
    const user = listed(ended, {
      path: '/home/me/app',
      inside: undefined,
      state: 'unchecked',
      record: undefined,
    });

    const plan = planClean(
      { worktrees: [user], branches: [branchOf(ended)], folders: [] },
      claims({ '12-1': 'ended' }),
      root,
    );

    assert.deepEqual(plan, {
      actions: [],
      kept: ['kept branch foedrum/12-1/implement/1: checked out in /home/me/app'],
    });
  });

  it('keeps the branch of a leased attempt', () => {
    const plan = planClean(
      { worktrees: [], branches: [branchOf(ended)], folders: [] },
      claims({ '12-1': 'ended' }, [ended]),
      root,
    );

    assert.deepEqual(plan, {
      actions: [],
      kept: ['kept branch foedrum/12-1/implement/1: its attempt holds a live lease'],
    });
  });

  it('looks only at one batch when given one', () => {
    const other = ref('13-1');

    const plan = planClean(
      facts([listed(ended), listed(other)]),
      claims({ '12-1': 'ended', '13-1': 'ended' }),
      root,
      { batchId: '13-1' },
    );

    assert.deepEqual(
      plan.actions.map((action) => ('label' in action ? action.label : action.branch)),
      ['13-1/implement/1', '13-1'],
    );
  });

  it('never removes a folder with a .git file as one git does not know', () => {
    // git lists the worktree under another spelling of its path, for example through a link.
    const folders = [{ batchId: '12-1', attempts: ['implement/1'], withGit: ['implement/1'] }];

    const plan = planClean(
      { worktrees: [], branches: [], folders },
      claims({ '12-1': 'ended' }),
      root,
    );

    assert.deepEqual(plan, {
      actions: [],
      kept: [
        'kept folder 12-1/implement/1: it has a .git file, but git does not list it as a worktree of this clone',
      ],
    });
  });

  it('keeps a folder git does not know while a worktree git lists is inside it', () => {
    const inner = listed(ended, {
      path: join(root, '12-1', 'implement', '1', 'sub'),
      inside: '12-1/implement/1/sub',
      branch: undefined,
    });
    const folders = [{ batchId: '12-1', attempts: ['implement/1'] }];

    const plan = planClean(
      { worktrees: [inner], branches: [], folders },
      claims({ '12-1': 'ended' }),
      root,
    );

    assert.deepEqual(plan.kept, [
      'kept worktree 12-1/implement/1/sub: not an attempt folder',
      'kept folder 12-1/implement/1: it contains the worktree 12-1/implement/1/sub',
    ]);
    assert.deepEqual(plan.actions, []);
  });

  it('prunes a stale record below an attempt folder, and then removes the attempt worktree', () => {
    const outer = listed(ref('12-1', 'c'));
    const stale = listed(ref('12-1', 'c'), {
      path: join(outer.path, 'sub'),
      inside: '12-1/c/1/sub',
      branch: undefined,
      state: 'gone',
      record: '/repo/.git/worktrees/sub',
    });

    const plan = planClean(facts([outer, stale]), claims({ '12-1': 'ended' }), root);

    assert.deepEqual(plan.kept, []);
    assert.deepEqual(
      plan.actions.map((action) => ('label' in action ? `${action.kind} ${action.label}` : '')),
      ['remove 12-1/c/1', 'prune 12-1/c/1/sub', 'remove-batch-folder 12-1'],
    );
  });

  it('keeps the empty folder of a live batch', () => {
    const plan = planClean(
      { worktrees: [], branches: [], folders: [{ batchId: '13-1', attempts: [] }] },
      claims({ '13-1': 'live' }),
      root,
    );

    assert.deepEqual(plan, { actions: [], kept: [] });
  });
});

describe('planWorktree', () => {
  const attempt = ref('12-1');
  const branch = 'foedrum/12-1/implement/1';
  const none: AttemptFacts = {
    listed: undefined,
    folderExists: false,
    branchTip: undefined,
    checkedOutAt: undefined,
  };
  const newAt = { kind: 'new', base: 'base' } as const;
  const resumeAt = { kind: 'resume', commit: 'recorded' } as const;

  it('adds a new branch at the base, or at the recorded commit', () => {
    assert.deepEqual(planWorktree(attempt, none, newAt), {
      kind: 'add',
      prune: undefined,
      newBranch: true,
      at: 'base',
    });
    assert.deepEqual(planWorktree(attempt, none, resumeAt), {
      kind: 'add',
      prune: undefined,
      newBranch: true,
      at: 'recorded',
    });
  });

  it('reuses the worktree a crashed start of the same attempt left, while it is untouched', () => {
    const facts: AttemptFacts = {
      ...none,
      listed: listed(attempt),
      folderExists: true,
      branchTip: 'base',
    };
    assert.deepEqual(planWorktree(attempt, facts, newAt), { kind: 'reuse' });
    assert.equal(planWorktree(attempt, { ...facts, branchTip: 'moved' }, newAt).kind, 'refuse');
    const dirty = { ...facts, listed: listed(attempt, { state: 'dirty' }) };
    assert.equal(planWorktree(attempt, dirty, newAt).kind, 'refuse');
  });

  it('reuses the worktree of a resumed attempt as it is', () => {
    const facts: AttemptFacts = {
      ...none,
      listed: listed(attempt, { state: 'dirty' }),
      folderExists: true,
      branchTip: 'later',
    };
    assert.deepEqual(planWorktree(attempt, facts, resumeAt), { kind: 'reuse' });
    const other = { ...facts, listed: listed(attempt, { branch: 'foedrum/12-1/other/1' }) };
    assert.equal(planWorktree(attempt, other, resumeAt).kind, 'refuse');
  });

  it('prunes a stale record at the folder first', () => {
    const facts: AttemptFacts = { ...none, listed: listed(attempt, { state: 'gone' }) };
    assert.deepEqual(planWorktree(attempt, facts, newAt), {
      kind: 'add',
      prune: '/repo/.git/worktrees/implement1',
      newBranch: true,
      at: 'base',
    });
  });

  it('checks out an existing branch that is free: at the base when new, as it is when resumed', () => {
    const atBase: AttemptFacts = { ...none, branchTip: 'base' };
    assert.deepEqual(planWorktree(attempt, atBase, newAt), {
      kind: 'add',
      prune: undefined,
      newBranch: false,
      at: branch,
    });
    const later: AttemptFacts = { ...none, branchTip: 'later' };
    assert.equal(planWorktree(attempt, later, newAt).kind, 'refuse');
    assert.deepEqual(planWorktree(attempt, later, resumeAt), {
      kind: 'add',
      prune: undefined,
      newBranch: false,
      at: branch,
    });
  });

  it('refuses a folder git does not know and a branch checked out elsewhere', () => {
    const folder = planWorktree(attempt, { ...none, folderExists: true }, newAt);
    assert.equal(folder.kind, 'refuse');
    assert.match(folder.kind === 'refuse' ? folder.reason : '', /12-1\/implement\/1/);
    for (const target of [newAt, resumeAt]) {
      const elsewhere = planWorktree(
        attempt,
        { ...none, branchTip: 'base', checkedOutAt: '/home/me/app' },
        target,
      );
      assert.deepEqual(elsewhere, {
        kind: 'refuse',
        reason: `the branch ${branch} is checked out in /home/me/app`,
      });
    }
  });

  it('never hands a resumed attempt a folder whose removal stopped part-way', () => {
    const halfRemoved: AttemptFacts = {
      ...none,
      listed: listed(attempt, { state: 'no-git' }),
      folderExists: true,
    };
    assert.equal(planWorktree(attempt, halfRemoved, resumeAt).kind, 'refuse');
  });
});
