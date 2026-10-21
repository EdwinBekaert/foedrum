// The task-tree branches the cleanup keeps, as `foedrum status` lists them (ADR 0084, ADR 0092):
// the pure plan over the claims and git's readings, and the shell that reads git, with a fake git
// (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type BranchReading, keptBranchLines } from '../../src/cli/kept-branches.ts';
import { readKeptBranches } from '../../src/cli/kept-branches-git.ts';
import { type Batch, emptyState, type State } from '../../src/engine/fold.ts';
import { failed, fakeGit, ok } from '../helpers/attempt-worktrees.ts';

const START = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const CLONE = '/src/app';

const read = (ahead: number | undefined, tip = TIP): BranchReading => ({
  kind: 'read',
  clone: CLONE,
  tip,
  ahead,
});

describe('keptBranchLines', () => {
  it('lists a kept branch with its batch, its commits past the start and the line that drops it', () => {
    const unpushed = new Map([['foedrum/12-1/brew/2', START]]);
    const readings = new Map([['foedrum/12-1/brew/2', read(3)]]);

    assert.deepEqual(keptBranchLines(unpushed, readings), [
      '1 kept branch: commits of ended batches that no push recorded (ADR 0084); take them, then drop the branch',
      '',
      '  12-1  foedrum/12-1/brew/2  3 commits past the start  in /src/app: git branch -D foedrum/12-1/brew/2',
    ]);
  });

  it('lists nothing when nothing is kept: no branch, a branch at its start, a branch gone', () => {
    assert.deepEqual(keptBranchLines(new Map(), new Map()), []);
    const unpushed = new Map([
      ['foedrum/12-1/review/1', START],
      ['foedrum/13-1/brew/1', START],
    ]);
    const readings = new Map<string, BranchReading>([
      // A batch whose brewers committed nothing: the cleanup deletes its branch (ADR 0084).
      ['foedrum/12-1/review/1', read(0, START)],
      // Taken and dropped already.
      ['foedrum/13-1/brew/1', { kind: 'gone' }],
    ]);
    assert.deepEqual(keptBranchLines(unpushed, readings), []);
  });

  it('counts each branch in the singular or plural, in the order of the claims', () => {
    const unpushed = new Map([
      ['foedrum/9-1/brew/1', START],
      ['foedrum/12-1/brew/2', START],
    ]);
    const readings = new Map([
      ['foedrum/9-1/brew/1', read(1)],
      ['foedrum/12-1/brew/2', read(12)],
    ]);

    assert.deepEqual(keptBranchLines(unpushed, readings), [
      '2 kept branches: commits of ended batches that no push recorded (ADR 0084); take them, then drop the branch',
      '',
      '  9-1   foedrum/9-1/brew/1   1 commit past the start    in /src/app: git branch -D foedrum/9-1/brew/1',
      '  12-1  foedrum/12-1/brew/2  12 commits past the start  in /src/app: git branch -D foedrum/12-1/brew/2',
    ]);
  });

  it("says when the batch's start is unknown, which keeps the branch whatever its tip (ADR 0084)", () => {
    const unpushed = new Map([['foedrum/12-1/brew/2', '']]);
    const readings = new Map([['foedrum/12-1/brew/2', read(undefined)]]);

    assert.equal(
      keptBranchLines(unpushed, readings).at(-1),
      '  12-1  foedrum/12-1/brew/2  start unknown  in /src/app: git branch -D foedrum/12-1/brew/2',
    );
  });

  it('names a branch git could not be asked about, with the reason, and no line to drop it', () => {
    const unpushed = new Map([
      ['foedrum/12-1/brew/2', START],
      ['foedrum/13-1/brew/1', START],
    ]);
    const readings = new Map<string, BranchReading>([
      ['foedrum/12-1/brew/2', { kind: 'unread', reason: 'no clone for acme/app' }],
    ]);

    assert.deepEqual(keptBranchLines(unpushed, readings).slice(2), [
      '  12-1  foedrum/12-1/brew/2  not read: no clone for acme/app',
      '  13-1  foedrum/13-1/brew/1  not read',
    ]);
  });
});

describe('readKeptBranches', () => {
  const batch = (id: string, repo: string): Batch => ({
    id,
    issue: 12,
    lane: { kind: 'cancelled', by: 'ann', via: 'terminal' },
    steps: new Map(),
    rewinds: [],
    taskTree: { kind: 'attempt', stepId: 'brew', attempt: 2, repo },
  });
  const state = (...batches: Batch[]): State => ({
    ...emptyState,
    batches: new Map(batches.map((b) => [b.id, b])),
  });
  const cloneOf = (repo: string) => (repo === 'acme/app' ? CLONE : undefined);
  const branch = 'foedrum/12-1/brew/2';

  it("reads the tip and counts the commits past the start in the clone of the batch's repository", async () => {
    const { calls, git } = fakeGit((_cwd, args) =>
      args[0] === 'rev-parse' ? ok(`${TIP}\n`) : ok('3\n'),
    );

    const readings = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, START]]),
      { git, cloneOf },
    );

    assert.deepEqual(readings, new Map([[branch, read(3)]]));
    assert.deepEqual(calls, [
      [CLONE, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      [CLONE, 'rev-list', '--count', `${START}..${TIP}`],
    ]);
  });

  it('counts nothing at the start, and nothing when the start is unknown', async () => {
    const { calls, git } = fakeGit(() => ok(`${START}\n`));
    const atStart = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, START]]),
      { git, cloneOf },
    );
    assert.deepEqual(atStart, new Map([[branch, read(0, START)]]));
    const unknown = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, '']]),
      { git, cloneOf },
    );
    assert.deepEqual(unknown, new Map([[branch, read(undefined, START)]]));
    assert.deepEqual(
      calls.map((call) => call[1]),
      ['rev-parse', 'rev-parse'],
    );
  });

  it('says a branch the clone no longer has is gone', async () => {
    const { git } = fakeGit(() => ({ code: 1, stdout: '', stderr: '' }));
    const readings = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, START]]),
      { git, cloneOf },
    );
    assert.deepEqual(readings, new Map([[branch, { kind: 'gone' }]]));
  });

  it('says why a branch could not be read: no clone, a git that fails or throws', async () => {
    const noClone = await readKeptBranches(
      state(batch('12-1', 'acme/other')),
      new Map([[branch, START]]),
      { git: fakeGit().git, cloneOf },
    );
    assert.deepEqual(noClone.get(branch), {
      kind: 'unread',
      reason: 'no clone for acme/other in foedrum.jsonc and .foedrum/local.jsonc',
    });

    const fails = fakeGit((_cwd, args) =>
      args[0] === 'rev-parse' ? failed('fatal: not a git repository\n') : undefined,
    );
    const notRepo = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, START]]),
      { git: fails.git, cloneOf },
    );
    assert.deepEqual(notRepo.get(branch), {
      kind: 'unread',
      reason: `git rev-parse in ${CLONE} failed: fatal: not a git repository`,
    });

    const countFails = fakeGit((_cwd, args) =>
      args[0] === 'rev-parse' ? ok(`${TIP}\n`) : failed('fatal: bad revision\n'),
    );
    const noCount = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, START]]),
      { git: countFails.git, cloneOf },
    );
    assert.deepEqual(noCount.get(branch), {
      kind: 'unread',
      reason: `git rev-list in ${CLONE} failed: fatal: bad revision`,
    });

    const throws = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, START]]),
      {
        git: async () => {
          throw new Error('spawn git ENOENT');
        },
        cloneOf,
      },
    );
    assert.deepEqual(throws.get(branch), {
      kind: 'unread',
      reason: `git rev-parse in ${CLONE} failed: spawn git ENOENT`,
    });
  });

  it('takes a silent exit 1 as gone from rev-parse only, and names the exit code when git says nothing', async () => {
    // rev-list has no quiet miss: a silent failure is not a count of 0.
    const { git } = fakeGit((_cwd, args) =>
      args[0] === 'rev-parse' ? ok(`${TIP}\n`) : { code: 1, stdout: '', stderr: '' },
    );
    const readings = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, START]]),
      { git, cloneOf },
    );
    assert.deepEqual(readings.get(branch), {
      kind: 'unread',
      reason: `git rev-list in ${CLONE} failed: git exited with 1`,
    });
  });

  it('lists a branch rev-parse failed on silently with another code as not read, never gone', async () => {
    const { git } = fakeGit(() => ({ code: 128, stdout: '', stderr: '' }));
    const readings = await readKeptBranches(
      state(batch('12-1', 'acme/app')),
      new Map([[branch, START]]),
      { git, cloneOf },
    );
    assert.deepEqual(readings.get(branch), {
      kind: 'unread',
      reason: `git rev-parse in ${CLONE} failed: git exited with 128`,
    });
  });

  it('reads the branch holding a rewound task tree in the clone its attempt wrote in (#255)', async () => {
    const { calls, git } = fakeGit((_cwd, args) =>
      args[0] === 'rev-parse' ? ok(`${TIP}\n`) : ok('1\n'),
    );
    const worktree = { repo: 'acme/app', path: '/work/brew/2', branch, commit: TIP };
    const attempt = {
      phase: 'finished',
      attempt: 2,
      deadlineAt: '2026-10-15T00:00:00.000Z',
      worktree,
      outcome: { kind: 'failed', retryable: true, reason: 'the run broke' },
    } as const;
    const rewound: Batch = {
      ...batch('12-1', 'acme/app'),
      steps: new Map([['brew', { id: 'brew', inputs: [], attempts: new Map([[2, attempt]]) }]]),
      taskTree: { kind: 'rewound', shas: { 'acme/app': TIP } },
    };

    const readings = await readKeptBranches(state(rewound), new Map([[branch, START]]), {
      git,
      cloneOf,
    });

    assert.deepEqual(readings, new Map([[branch, read(1)]]));
    assert.equal(calls[0]?.[0], CLONE);
  });

  it("reads a rewound task tree's branch in the clone of its attempt's repository, not the batch's (review of #288)", async () => {
    const LIB_CLONE = '/src/lib';
    const { calls, git } = fakeGit((_cwd, args) =>
      args[0] === 'rev-parse' ? ok(`${TIP}\n`) : ok('1\n'),
    );
    const worktree = { repo: 'acme/lib', path: '/work/brew/2', branch, commit: TIP };
    const attempt = {
      phase: 'finished',
      attempt: 2,
      deadlineAt: '2026-10-15T00:00:00.000Z',
      worktree,
      outcome: { kind: 'failed', retryable: true, reason: 'the run broke' },
    } as const;
    const rewound: Batch = {
      ...batch('12-1', 'acme/app'),
      steps: new Map([['brew', { id: 'brew', inputs: [], attempts: new Map([[2, attempt]]) }]]),
      taskTree: { kind: 'rewound', shas: { 'acme/app': START, 'acme/lib': TIP } },
    };

    const readings = await readKeptBranches(state(rewound), new Map([[branch, START]]), {
      git,
      cloneOf: (repo) => (repo === 'acme/lib' ? LIB_CLONE : cloneOf(repo)),
    });

    assert.deepEqual(readings, new Map([[branch, { ...read(1), clone: LIB_CLONE }]]));
    assert.deepEqual(
      calls.map((call) => call[0]),
      [LIB_CLONE, LIB_CLONE],
    );
  });

  it('says so for a rewound batch whose branch names no attempt it recorded, without asking git (review of #288)', async () => {
    const { calls, git } = fakeGit();
    const rewound: Batch = {
      ...batch('12-1', 'acme/app'),
      taskTree: { kind: 'rewound', shas: { 'acme/app': TIP } },
    };
    const readings = await readKeptBranches(state(rewound), new Map([[branch, START]]), {
      git,
      cloneOf,
    });
    assert.deepEqual(readings.get(branch), {
      kind: 'unread',
      reason: 'no task tree of batch 12-1 in the event store',
    });
    assert.deepEqual(calls, []);
  });

  it('says so for a branch whose batch the state has no task tree for', async () => {
    const { calls, git } = fakeGit();
    const readings = await readKeptBranches(state(), new Map([[branch, START]]), {
      git,
      cloneOf,
    });
    assert.deepEqual(readings.get(branch), {
      kind: 'unread',
      reason: 'no task tree of batch 12-1 in the event store',
    });
    assert.deepEqual(calls, []);
  });
});
