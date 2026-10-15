import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cleanWorktrees } from '../../scripts/worktrees-clean.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const script = join(import.meta.dirname, '..', '..', 'scripts', 'worktrees-clean.ts');

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

const configure = (cwd: string): void => {
  git(cwd, ['config', 'user.name', 'Test Brewer']);
  git(cwd, ['config', 'user.email', 'brewer@example.com']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
};

const commitFile = (cwd: string, file: string, message: string): void => {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-q', '-m', message]);
};

// A bare `origin`, the main checkout cloned from it, and a second clone (`hub`) that stands in
// for GitHub: pull requests are merged there with a merge commit, so the main checkout's own
// `main` stays behind, as it does after a merge on GitHub.
interface Repo {
  dir: TempDir;
  main: string;
  origin: string;
  hub: string;
  worktree: (name: string, options?: { push?: boolean; commit?: boolean; path?: string }) => string;
  mergeOnHub: (branch: string, options?: { deleteBranch?: boolean }) => void;
  localBranches: () => string[];
  remoteBranches: () => string[];
  worktreePaths: () => string[];
}

const makeRepo = (): Repo => {
  const dir = makeTempDir('clean');
  const origin = join(dir.path, 'origin.git');
  const main = join(dir.path, 'main');
  const hub = join(dir.path, 'hub');
  git(dir.path, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(dir.path, ['init', '-q', '-b', 'main', main]);
  configure(main);
  writeFileSync(join(main, '.gitignore'), '.claude/worktrees/\n');
  git(main, ['add', '.gitignore']);
  git(main, ['commit', '-q', '-m', 'Initial commit']);
  git(main, ['remote', 'add', 'origin', origin]);
  git(main, ['push', '-q', '-u', 'origin', 'main']);
  git(main, ['remote', 'set-head', 'origin', 'main']);
  git(dir.path, ['clone', '-q', origin, hub]);
  configure(hub);

  const list = (cwd: string, args: string[]): string[] =>
    git(cwd, args)
      .split('\n')
      .filter((line) => line !== '');

  return {
    dir,
    main,
    origin,
    hub,
    worktree: (
      name,
      { push = true, commit = true, path = join(main, '.claude', 'worktrees', name) } = {},
    ) => {
      git(main, ['worktree', 'add', '-q', '-b', name, path, 'origin/main']);
      if (commit) commitFile(path, `${name.replaceAll('/', '-')}.txt`, `Work on ${name}`);
      if (push) git(path, ['push', '-q', '-u', 'origin', name]);
      return path;
    },
    // The repository deletes head branches on merge, so by default the remote branch goes too.
    mergeOnHub: (branch, { deleteBranch = true } = {}) => {
      git(hub, ['fetch', '-q', 'origin']);
      git(hub, ['merge', '-q', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`]);
      git(hub, ['push', '-q', 'origin', 'main']);
      if (deleteBranch) git(hub, ['push', '-q', 'origin', '--delete', branch]);
    },
    localBranches: () => list(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    remoteBranches: () => list(origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    worktreePaths: () =>
      list(main, ['worktree', 'list', '--porcelain'])
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length)),
  };
};

const lock = (repo: Repo, path: string, reason: string): void => {
  git(repo.main, ['worktree', 'lock', '--reason', reason, path]);
};

const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ok(child.pid !== undefined && child.pid > 0);
  return child.pid;
};

const hasLine = (lines: string[], ...parts: (string | RegExp)[]): boolean =>
  lines.some((line) =>
    parts.every((part) => (typeof part === 'string' ? line.includes(part) : part.test(line))),
  );

const tree = (path: string): string[] =>
  readdirSync(path, { recursive: true, encoding: 'utf8' }).map((entry) => join(path, entry));

describe('cleanWorktrees', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => removeTree(repo.dir.path));

  it('keeps a merged worktree and its branch while the remote branch still exists', async () => {
    const path = repo.worktree('7-merged');
    repo.mergeOnHub('7-merged', { deleteBranch: false });

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(path), lines.join('\n'));
    assert.deepEqual(repo.localBranches(), ['7-merged', 'main']);
    assert.deepEqual(repo.remoteBranches(), ['7-merged', 'main']);
    assert.ok(hasLine(lines, 'kept worktree', '7-merged', 'remote branch'), lines.join('\n'));
  });

  it('removes a merged worktree and its branch once the remote branch is gone', async () => {
    const path = repo.worktree('8-auto-deleted');
    repo.mergeOnHub('8-auto-deleted');

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.equal(existsSync(path), false);
    assert.equal(repo.worktreePaths().length, 1);
    assert.deepEqual(repo.localBranches(), ['main']);
    assert.ok(hasLine(lines, 'removed worktree', '8-auto-deleted'), lines.join('\n'));
    assert.ok(hasLine(lines, 'deleted branch 8-auto-deleted'), lines.join('\n'));
  });

  it('keeps an unmerged worktree, its branch and its remote branch', async () => {
    const path = repo.worktree('9-open');

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(path));
    assert.deepEqual(repo.localBranches(), ['9-open', 'main']);
    assert.deepEqual(repo.remoteBranches(), ['9-open', 'main']);
    assert.ok(hasLine(lines, 'kept worktree', '9-open', 'not merged'), lines.join('\n'));
  });

  it('keeps a merged worktree with uncommitted or untracked changes', async () => {
    const path = repo.worktree('10-dirty');
    repo.mergeOnHub('10-dirty');
    writeFileSync(join(path, 'notes.txt'), 'not committed\n');

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(join(path, 'notes.txt')));
    assert.deepEqual(repo.localBranches(), ['10-dirty', 'main']);
    assert.ok(hasLine(lines, 'kept worktree', '10-dirty', 'changes'), lines.join('\n'));
  });

  it('keeps a merged worktree locked by a live session', async () => {
    const path = repo.worktree('11-live');
    repo.mergeOnHub('11-live');
    lock(repo, path, `claude session 11-live (pid ${process.pid})`);

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(path));
    assert.deepEqual(repo.localBranches(), ['11-live', 'main']);
    assert.ok(hasLine(lines, 'kept worktree', '11-live', String(process.pid)), lines.join('\n'));
  });

  it('unlocks and removes a merged worktree whose session pid is gone', async () => {
    const path = repo.worktree('12-dead');
    repo.mergeOnHub('12-dead');
    lock(repo, path, `claude session 12-dead (pid ${deadPid()})`);

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.equal(existsSync(path), false);
    assert.deepEqual(repo.localBranches(), ['main']);
    assert.ok(hasLine(lines, 'removed worktree', '12-dead'), lines.join('\n'));
  });

  it('keeps a merged worktree locked for another reason', async () => {
    const path = repo.worktree('13-locked');
    repo.mergeOnHub('13-locked');
    lock(repo, path, 'on a USB drive');

    const lines = await cleanWorktrees({ cwd: repo.main, isPidAlive: () => false });

    assert.ok(existsSync(path));
    assert.ok(hasLine(lines, 'kept worktree', '13-locked', 'on a USB drive'), lines.join('\n'));
  });

  it('prunes the record of a merged worktree whose folder is gone', async () => {
    const path = repo.worktree('14-stale');
    repo.mergeOnHub('14-stale');
    rmSync(path, { recursive: true, force: true });

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.deepEqual(repo.worktreePaths().length, 1);
    assert.deepEqual(repo.localBranches(), ['main']);
    assert.ok(hasLine(lines, '14-stale', 'folder is gone'), lines.join('\n'));
  });

  it('keeps the record of a missing worktree that a live session still locks', async () => {
    const path = repo.worktree('30-moved');
    lock(repo, path, `claude session 30-moved (pid ${process.pid})`);
    rmSync(path, { recursive: true, force: true });

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.equal(repo.worktreePaths().length, 2);
    assert.deepEqual(repo.localBranches(), ['30-moved', 'main']);
    assert.ok(hasLine(lines, 'kept stale worktree', '30-moved', 'live session'), lines.join('\n'));
  });

  it('keeps a fresh worktree and branches with no commits of their own', async () => {
    // A session that started a worktree and exited before its first commit.
    const path = repo.worktree('31-fresh', { commit: false, push: false });
    lock(repo, path, `claude session 31-fresh (pid ${deadPid()})`);
    git(repo.main, ['branch', '32-placeholder', 'origin/main']);
    git(repo.main, ['push', '-q', 'origin', '32-placeholder']);

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(path), lines.join('\n'));
    assert.deepEqual(repo.localBranches(), ['31-fresh', '32-placeholder', 'main']);
    assert.deepEqual(repo.remoteBranches(), ['32-placeholder', 'main']);
  });

  it('keeps a worktree folder whose .git file is missing', async () => {
    const path = repo.worktree('33-broken');
    repo.mergeOnHub('33-broken');
    writeFileSync(join(path, 'notes.txt'), 'not committed\n');
    rmSync(join(path, '.git'));

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(join(path, 'notes.txt')), lines.join('\n'));
    assert.ok(hasLine(lines, 'kept worktree', '33-broken'), lines.join('\n'));
  });

  it('keeps a worktree that has the default branch checked out', async () => {
    git(repo.main, ['switch', '-q', '-c', 'side']);
    const path = join(repo.main, '.claude', 'worktrees', '36-main');
    git(repo.main, ['worktree', 'add', '-q', path, 'main']);

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(path), lines.join('\n'));
    assert.ok(repo.localBranches().includes('main'));
    assert.deepEqual(repo.remoteBranches(), ['main']);
    assert.ok(hasLine(lines, 'kept worktree', '36-main'), lines.join('\n'));
  });

  it('finishes a removal that git leaves half done', {
    skip: process.platform !== 'win32' && 'only Windows refuses to delete a busy folder',
  }, async () => {
    const path = repo.worktree('34-half');
    repo.mergeOnHub('34-half');
    // An ignored folder that sorts before .git, held by a process: git deletes part of the
    // worktree, fails on this folder and leaves the .git file in place.
    const held = join(path, '.claude', 'worktrees', 'held');
    mkdirSync(held, { recursive: true });
    const holder: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: held,
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    // The holder lets go while removeTree waits before its first retry.
    const release = async (): Promise<void> => {
      holder.kill();
      await exited;
    };
    try {
      const lines = await cleanWorktrees({ cwd: repo.main, remove: { sleep: release } });

      assert.equal(existsSync(path), false, lines.join('\n'));
      assert.ok(hasLine(lines, 'removed worktree', '34-half'), lines.join('\n'));
    } finally {
      await release();
    }
  });

  it('prunes the record of a nested scratch worktree whose folder is gone', async () => {
    const parent = repo.worktree('29-parent', { push: false });
    // Like the brew-review skill's scratch tree: detached, deep inside another worktree.
    const scratch = join(parent, '.foedrum', 'tmp', '51', 'scratch', 'tree');
    git(repo.main, ['worktree', 'add', '-q', '--detach', scratch, 'origin/main']);
    rmSync(scratch, { recursive: true, force: true });

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(parent));
    assert.equal(repo.worktreePaths().length, 2, lines.join('\n'));
    assert.deepEqual(readdirSync(join(repo.main, '.git', 'worktrees')), ['29-parent']);
    assert.ok(hasLine(lines, 'scratch/tree', 'folder is gone'), lines.join('\n'));
  });

  it('deletes merged local branches without a worktree and keeps the rest', async () => {
    for (const name of ['15-merged', '16-open', '38-develop']) {
      const path = repo.worktree(name, { push: name !== '16-open' });
      git(repo.main, ['worktree', 'remove', path]);
    }
    repo.mergeOnHub('15-merged');
    // A long-lived branch merged into main whose remote branch stays.
    repo.mergeOnHub('38-develop', { deleteBranch: false });

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.deepEqual(repo.localBranches(), ['16-open', '38-develop', 'main']);
    assert.deepEqual(repo.remoteBranches(), ['38-develop', 'main']);
    assert.ok(hasLine(lines, 'deleted branch 15-merged'), lines.join('\n'));
    assert.ok(hasLine(lines, 'kept branch 16-open', 'not merged'), lines.join('\n'));
    assert.ok(hasLine(lines, 'kept branch 38-develop', 'remote branch'), lines.join('\n'));
  });

  it('prunes a stale record whose gitdir is relative', async (t) => {
    git(repo.main, ['config', 'worktree.useRelativePaths', 'true']);
    const path = repo.worktree('39-relative', { push: false });
    const gitdir = readFileSync(
      join(repo.main, '.git', 'worktrees', '39-relative', 'gitdir'),
      'utf8',
    );
    if (isAbsolute(gitdir.trim())) {
      t.skip('this git writes absolute gitdir paths (worktree.useRelativePaths needs git 2.48)');
      return;
    }
    rmSync(path, { recursive: true, force: true });

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.equal(repo.worktreePaths().length, 1, lines.join('\n'));
    assert.ok(hasLine(lines, '39-relative', 'folder is gone'), lines.join('\n'));
  });

  it('never touches the main checkout or worktrees outside .claude/worktrees/', async () => {
    const outside = repo.worktree('17-outside', { path: join(repo.dir.path, 'outside') });
    const parent = repo.worktree('18-parent');
    const nested = repo.worktree('19-nested', {
      path: join(parent, '.claude', 'worktrees', 'nested'),
    });
    for (const branch of ['17-outside', '18-parent', '19-nested']) repo.mergeOnHub(branch);

    const lines = await cleanWorktrees({ cwd: repo.main });

    for (const path of [repo.main, outside, parent, nested]) assert.ok(existsSync(path), path);
    assert.equal(repo.worktreePaths().length, 4);
    assert.deepEqual(repo.localBranches(), ['17-outside', '18-parent', '19-nested', 'main']);
    assert.ok(hasLine(lines, 'kept worktree', '18-parent', 'contains'), lines.join('\n'));
    assert.equal(hasLine(lines, '17-outside'), false, lines.join('\n'));
    assert.equal(hasLine(lines, '19-nested'), false, lines.join('\n'));
  });

  it('finds the main checkout from inside a worktree and keeps that worktree', async () => {
    const current = repo.worktree('20-current');
    const other = repo.worktree('21-other');
    repo.mergeOnHub('20-current');
    repo.mergeOnHub('21-other');

    const lines = await cleanWorktrees({ cwd: current });

    assert.ok(existsSync(current));
    assert.equal(existsSync(other), false);
    assert.ok(hasLine(lines, 'kept worktree', '20-current', 'current'), lines.join('\n'));
  });

  it('touches nothing when origin cannot be fetched', async () => {
    const path = repo.worktree('22-offline');
    repo.mergeOnHub('22-offline');
    git(repo.main, ['remote', 'set-url', 'origin', join(repo.dir.path, 'missing.git')]);

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.ok(existsSync(path));
    assert.ok(hasLine(lines, 'git fetch'), lines.join('\n'));
  });

  it('removes a merged worktree whose folders and files are read-only', async () => {
    const path = repo.worktree('23-read-only');
    mkdirSync(join(path, 'deep', 'er'), { recursive: true });
    writeFileSync(join(path, 'deep', 'er', 'ignored.log'), 'x');
    writeFileSync(join(path, '.gitignore'), '*.log\n');
    git(path, ['add', '.gitignore']);
    git(path, ['commit', '-q', '-m', 'Ignore logs']);
    git(path, ['push', '-q', 'origin', '23-read-only']);
    repo.mergeOnHub('23-read-only');
    // Everything but the worktree's .git file, which git itself must still read.
    for (const entry of [...tree(path).reverse(), path]) {
      if (entry !== join(path, '.git')) chmodSync(entry, statSync(entry).mode & ~0o222);
    }

    const lines = await cleanWorktrees({ cwd: repo.main });

    assert.equal(existsSync(path), false, lines.join('\n'));
    assert.deepEqual(repo.localBranches(), ['main']);
  });

  it('reports a worktree that stays busy and carries on', {
    skip: process.platform !== 'win32' && 'only Windows refuses to delete a busy folder',
  }, async () => {
    const busy = repo.worktree('24-busy');
    const free = repo.worktree('25-free');
    repo.mergeOnHub('24-busy');
    repo.mergeOnHub('25-free');
    // A process whose working directory is inside the folder keeps Windows from deleting it.
    const holder: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: busy,
      stdio: 'ignore',
    });
    try {
      const lines = await cleanWorktrees({
        cwd: repo.main,
        remove: { attempts: 2, delayMs: 1 },
      });

      assert.ok(hasLine(lines, 'could not delete', '24-busy'), lines.join('\n'));
      assert.equal(existsSync(free), false);
      assert.ok(hasLine(lines, 'removed worktree', '25-free'), lines.join('\n'));
    } finally {
      const exited = new Promise((resolve) => holder.once('exit', resolve));
      holder.kill();
      await exited;
    }
  });
});

describe('worktrees-clean --session-start', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => removeTree(repo.dir.path));

  const runSessionStart = (projectDir: string) =>
    spawnSync(process.execPath, [script, '--session-start'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });

  it('cleans up when the session starts in the main checkout', () => {
    const path = repo.worktree('26-merged');
    repo.mergeOnHub('26-merged');

    const result = runSessionStart(repo.main);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path), false);
    assert.match(result.stdout, /removed worktree/);
  });

  it('cleans up when the main checkout is opened through a symbolic link', () => {
    const path = repo.worktree('37-linked');
    repo.mergeOnHub('37-linked');
    const link = join(repo.dir.path, 'linked');
    symlinkSync(repo.main, link, 'junction');

    const result = runSessionStart(link);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path), false, result.stdout);
  });

  it('does nothing when the session starts inside a worktree', () => {
    const current = repo.worktree('27-current');
    const other = repo.worktree('28-other');
    repo.mergeOnHub('28-other');

    const result = runSessionStart(current);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(other));
    assert.equal(result.stdout, '');
  });

  it('never fails the session, even outside a git repository', () => {
    const result = runSessionStart(repo.dir.path);

    assert.equal(result.status, 0, result.stderr);
  });
});
