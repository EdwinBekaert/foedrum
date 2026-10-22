// The engine's git in a clone that attempt worktrees share, with real git: a bare origin, the
// user's clone and a managed repository's blobless one, and the worktree manager's fetch, the base
// fetch from a git directory of Foedrum's own (ADR 0090) and the push (ADR 0137). Every remote is a
// local bare repository: nothing reaches the network.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { removeTree } from '../../src/platform/remove.ts';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
import { openBranchPush } from '../../src/workspace/branch-push-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const bottle = 'foedrum/acme.brewery/12-1/acme.app';
const attempt = { batchId: '12-1', stepId: 'plan', attempt: 1 };

describe("the engine's git in a clone", () => {
  let dir: TempDir;
  before(() => {
    dir = makeTempDir('clone-config');
  });
  after(async () => {
    await removeTree(dir.path);
  });

  let runs = 0;
  let run: string;
  let origin: string;
  let user: string;
  let other: string;
  beforeEach(() => {
    run = join(dir.path, String(++runs));
    const seed = join(run, 'seed');
    origin = join(run, 'origin.git');
    user = join(run, 'user');
    other = join(run, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'readme.txt'), 'hello\n');
    git(seed, ['add', 'readme.txt']);
    git(seed, ['commit', '-q', '-m', 'Initial commit']);
    git(run, ['clone', '-q', '--bare', seed, origin]);
    git(run, ['clone', '-q', origin, user]);
    git(run, ['clone', '-q', origin, other]);
  });

  /** Commits `name` in `path` and returns the commit. */
  const commit = (path: string, name: string): string => {
    writeFileSync(join(path, name), `${name}\n`);
    git(path, ['add', name]);
    git(path, ['commit', '-q', '-m', name]);
    return git(path, ['rev-parse', 'HEAD']).trim();
  };

  it('fetches past a branch the remote deleted and made again as a folder, which the clone still tracks (review of #266)', async () => {
    git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/x']);
    git(user, ['fetch', '-q', 'origin']);
    git(other, ['push', '-q', 'origin', ':refs/heads/x']);
    const main = commit(other, 'merged.txt');
    git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/x/y', 'HEAD:refs/heads/main']);
    const worktrees = openAttemptWorktrees({
      git: runGit,
      workRoot: join(run, 'work'),
      repo: 'acme/app',
      clone: user,
      own: { url: origin, root: join(run, 'git') },
    });
    assert.equal((await worktrees.create(attempt, 'origin/main')).commit, main);
    const tracked = git(user, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/']);
    assert.match(tracked, /^refs\/remotes\/origin\/x\/y$/m);
    assert.doesNotMatch(tracked, /^refs\/remotes\/origin\/x$/m);
  });

  it("pushes and fetches for a managed repository's blobless clone, whose objects it shares, while main changes a file the clone has no copy of (review of #266)", async () => {
    // A file long enough that the server sends a change to it as a delta of the old one.
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} of a long file`);
    const change = (line: number): string => {
      lines[line] = `changed line ${line}`;
      writeFileSync(join(other, 'long.txt'), `${lines.join('\n')}\n`);
      git(other, ['add', 'long.txt']);
      git(other, ['commit', '-q', '-m', `Change line ${line}`]);
      git(other, ['push', '-q', served, 'HEAD:refs/heads/main']);
      return git(other, ['rev-parse', 'HEAD']).trim();
    };
    const served = join(run, 'served.git');
    git(run, ['clone', '-q', '--bare', origin, served]);
    git(served, ['config', 'uploadpack.allowFilter', 'true']);
    change(0);
    const url = pathToFileURL(served).href;
    // As ensureManagedClone makes it: bare, blobless, fetching into origin/*.
    const managed = join(run, 'clone.git');
    git(run, ['clone', '-q', '--bare', '--filter=blob:none', url, managed]);
    git(managed, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    git(managed, ['fetch', '-q', 'origin']);
    const own = { url, root: join(run, 'git') };
    const worktrees = openAttemptWorktrees({
      git: runGit,
      workRoot: join(run, 'work'),
      repo: 'acme/app',
      clone: managed,
      own,
    });
    const moved = change(100);
    const made = await worktrees.create(attempt, 'origin/main');
    assert.equal(made.commit, moved);
    assert.equal(git(managed, ['rev-parse', 'refs/remotes/origin/main']).trim(), moved);
    assert.match(readFileSync(join(made.path, 'long.txt'), 'utf8'), /changed line 100/);
    const again = change(200);
    assert.equal(await openBranchPush({ git: runGit, clone: managed, own }).baseTip('main'), again);
    const tip = commit(made.path, 'plan.txt');
    await openBranchPush({ git: runGit, clone: managed, own }).push(tip, bottle);
    assert.equal(git(served, ['rev-parse', `refs/heads/${bottle}`]).trim(), tip);
  });
});
