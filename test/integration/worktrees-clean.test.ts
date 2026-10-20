// Real git for the worktree cleanup's shell (ADR 0021): a bare origin, the main checkout, and
// a second clone that merges with a merge commit and deletes the head branch, as GitHub does.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { gitThrough } from '../../scripts/worktrees-clean.ts';
import { execProcessWith, isPidAlive } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { runGitWith } from '../../src/workspace/git.ts';
import { parseWorktreeList } from '../../src/workspace/worktree-list.ts';
import { cuedTimers, waitUntil } from '../helpers/load.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { lateKill } from './late-kill.ts';
import { killLeftovers, pidIn } from './leftover-processes.ts';
import { makeReadOnly } from './read-only.ts';

const script = join(import.meta.dirname, '..', '..', 'scripts', 'worktrees-clean.ts');

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

describe('worktrees-clean with real git', () => {
  let seeds: TempDir;
  let seed: string;
  let dir: TempDir;
  let main: string;
  let hub: string;
  // The first commit, made once for the file. Each test's origin is a bare copy of it, and the
  // main checkout and the hub are clones of that origin, tracking its main.
  before(() => {
    seeds = makeTempDir('clean-seed');
    seed = join(seeds.path, 'seed');
    git(seeds.path, ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
    git(seed, ['add', '.gitignore']);
    git(seed, ['commit', '-q', '-m', 'Initial commit']);
  });
  after(() => removeTree(seeds.path));

  beforeEach(() => {
    dir = makeTempDir('clean');
    const origin = join(dir.path, 'origin.git');
    main = join(dir.path, 'main');
    hub = join(dir.path, 'hub');
    git(dir.path, ['clone', '-q', '--bare', '--no-hardlinks', seed, origin]);
    git(dir.path, ['clone', '-q', origin, main]);
    git(dir.path, ['clone', '-q', origin, hub]);
  });
  afterEach(() => removeTree(dir.path));

  const worktree = (name: string, { push = true } = {}): string => {
    const path = join(main, '.claude', 'worktrees', name);
    git(main, ['worktree', 'add', '-q', '-b', name, path, 'origin/main']);
    writeFileSync(join(path, `${name}.txt`), `${name}\n`);
    git(path, ['add', `${name}.txt`]);
    git(path, ['commit', '-q', '-m', `Work on ${name}`]);
    if (push) git(path, ['push', '-q', '-u', 'origin', name]);
    return path;
  };
  const merge = (branch: string, { deleteBranch = true } = {}): void => {
    git(hub, ['fetch', '-q', 'origin']);
    git(hub, ['merge', '-q', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`]);
    git(hub, ['push', '-q', 'origin', 'main']);
    if (deleteBranch) git(hub, ['push', '-q', 'origin', '--delete', branch]);
  };
  const branches = (): string[] =>
    lines(git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
  const worktrees = (): string[] =>
    lines(git(main, ['worktree', 'list', '--porcelain'])).filter((l) => l.startsWith('worktree '));
  const clean = (cwd: string, args: string[] = []) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });

  it('removes merged worktrees whose remote branch is gone, at session start in the main checkout only', () => {
    const merged = worktree('7-merged');
    // A committed file in a subfolder: a read-only folder stops git from deleting what is in
    // it on Linux and macOS, so the removal works only when the cleanup clears the bits first.
    mkdirSync(join(merged, 'docs'));
    writeFileSync(join(merged, 'docs', 'notes.md'), 'notes\n');
    git(merged, ['add', 'docs']);
    git(merged, ['commit', '-q', '-m', 'Add notes']);
    git(merged, ['push', '-q', 'origin', '7-merged']);
    const develop = worktree('8-develop');
    const open = worktree('9-open');
    const dirty = worktree('10-dirty');
    merge('7-merged');
    merge('8-develop', { deleteBranch: false });
    merge('10-dirty');
    writeFileSync(join(dirty, 'notes.txt'), 'not committed\n');
    // Read-only files and folders, as Windows sometimes leaves them.
    for (const entry of [join('docs', 'notes.md'), 'docs', ...readdirSync(merged)]) {
      const path = join(merged, entry);
      if (entry !== '.git') chmodSync(path, statSync(path).mode & ~0o222);
    }

    const insideWorktree = clean(open, ['--session-start']);
    assert.equal(insideWorktree.status, 0, insideWorktree.stderr);
    assert.equal(insideWorktree.stdout, '');
    assert.ok(existsSync(merged));

    const result = clean(main, ['--session-start']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(merged), false, result.stdout);
    for (const path of [develop, open, dirty]) assert.ok(existsSync(path), result.stdout);
    assert.deepEqual(branches(), ['10-dirty', '8-develop', '9-open', 'main']);
    assert.match(result.stdout, /removed worktree \.claude\/worktrees\/7-merged/);
    assert.match(result.stdout, /deleted branch 7-merged/);
  });

  it('removes a merged worktree that holds a review scratch clone in its git-ignored .foedrum/', () => {
    const merged = worktree('15-reviewed');
    writeFileSync(join(merged, '.gitignore'), '.claude/worktrees/\n.foedrum/\n');
    git(merged, ['commit', '-q', '-am', 'Ignore .foedrum/']);
    git(merged, ['push', '-q', 'origin', '15-reviewed']);
    merge('15-reviewed');
    // The review skill's scratch tree: a shared clone, not a worktree, so no record exists.
    const tree = join(merged, '.foedrum', 'tmp', '15', 'scratch', 'tree');
    git(merged, ['clone', '-q', '--shared', '--no-checkout', merged, tree]);
    git(tree, ['checkout', '-q', '--detach', 'HEAD']);
    writeFileSync(join(tree, 'mutant.txt'), 'left behind by a review\n');
    assert.equal(worktrees().length, 2);

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(merged), false, result.stdout);
    assert.match(result.stdout, /removed worktree \.claude\/worktrees\/15-reviewed/);
    assert.deepEqual(branches(), ['main']);
  });

  it('finishes a worktree folder whose .git file is gone and whose branch may go', () => {
    const half = worktree('11-half');
    merge('11-half');
    rmSync(join(half, '.git'));

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(half), false, result.stdout);
    assert.equal(worktrees().length, 1, result.stdout);
    assert.deepEqual(branches(), ['main']);
  });

  it('prunes stale records at any depth, relative ones too, and keeps live sessions', () => {
    git(main, ['config', 'worktree.useRelativePaths', 'true']);
    const parent = worktree('12-parent', { push: false });
    const scratch = join(parent, '.foedrum', 'tmp', '12', 'scratch', 'tree');
    git(main, ['worktree', 'add', '-q', '--detach', scratch, 'origin/main']);
    rmSync(scratch, { recursive: true, force: true });
    const live = worktree('13-live');
    merge('13-live');
    git(main, [
      'worktree',
      'lock',
      '--reason',
      `claude session 13-live (pid ${process.pid})`,
      live,
    ]);
    // The unit tests' fixture still matches what this git prints.
    const listed = parseWorktreeList(git(main, ['worktree', 'list', '--porcelain', '-z']));
    const liveEntry = listed.find(({ branch }) => branch === '13-live');
    assert.equal(liveEntry?.lockReason, `claude session 13-live (pid ${process.pid})`);
    assert.ok(
      listed.some(({ path, branch }) => branch === undefined && path.endsWith('scratch/tree')),
    );

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(parent) && existsSync(live), result.stdout);
    assert.equal(worktrees().length, 3, result.stdout);
    assert.match(result.stdout, /scratch\/tree: folder is gone/);
    assert.match(
      result.stdout,
      /kept worktree \.claude\/worktrees\/13-live: locked by a live session/,
    );
  });

  it('never runs the fsmonitor of a git folder a .git file names, and still reads clean and dirty', () => {
    const clean16 = worktree('16-clean');
    const dirty = worktree('17-dirty');
    const forged = worktree('18-forged');
    for (const branch of ['16-clean', '17-dirty', '18-forged']) merge(branch);
    writeFileSync(join(dirty, 'notes.txt'), 'not committed\n');
    // What a brewer can write: a git folder inside its worktree, with an index so git status
    // reads it, a core.fsmonitor command, and the worktree's .git file pointing there (#263).
    const marker = join(dir.path, 'fsmonitor-ran');
    const monitor = join(dir.path, 'monitor.mjs');
    writeFileSync(
      monitor,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    );
    const forgedGit = join(forged, 'forged');
    git(dir.path, ['init', '-q', '--bare', forgedGit]);
    git(forgedGit, ['config', 'core.bare', 'false']);
    const slash = (path: string): string => path.replaceAll('\\', '/');
    git(forgedGit, [
      'config',
      'core.fsmonitor',
      `"${slash(process.execPath)}" "${slash(monitor)}"`,
    ]);
    // Removed first: Windows refuses to overwrite a hidden file, and git hides the .git file.
    rmSync(join(forged, '.git'));
    writeFileSync(join(forged, '.git'), 'gitdir: ./forged\n');
    git(forged, ['add', '18-forged.txt']);
    rmSync(marker, { force: true });

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false, 'the fsmonitor command of the forged git folder ran');
    assert.equal(existsSync(clean16), false, result.stdout);
    assert.match(result.stdout, /removed worktree \.claude\/worktrees\/16-clean/);
    assert.ok(existsSync(dirty) && existsSync(forged), result.stdout);
    assert.match(
      result.stdout,
      /kept worktree \.claude\/worktrees\/17-dirty: it has uncommitted or untracked changes/,
    );
    assert.match(result.stdout, /kept worktree \.claude\/worktrees\/18-forged: /);
  });

  it('removes a clean worktree without running the fsmonitor of the repository', () => {
    const merged = worktree('19-merged');
    merge('19-merged');
    // git worktree remove runs git status in the worktree, which reads the repository's
    // configuration, core.fsmonitor included (#263).
    const marker = join(dir.path, 'fsmonitor-ran');
    const monitor = join(dir.path, 'monitor.mjs');
    writeFileSync(
      monitor,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    );
    const slash = (path: string): string => path.replaceAll('\\', '/');
    git(main, ['config', 'core.fsmonitor', `"${slash(process.execPath)}" "${slash(monitor)}"`]);

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(merged), false, result.stdout);
    assert.equal(existsSync(marker), false, 'the fsmonitor command of the repository ran');
  });

  it('removes read-only records git no longer lists, outside .claude/worktrees/ too', () => {
    // A review run from the main checkout, whose removal stopped after deleting the gitdir file.
    const scratch = join(main, '.foedrum', 'tmp', '14', 'scratch', 'tree');
    git(main, ['worktree', 'add', '-q', '--detach', scratch, 'origin/main']);
    const record = join(main, '.git', 'worktrees', 'tree');
    rmSync(join(main, '.foedrum'), { recursive: true, force: true });
    rmSync(join(record, 'gitdir'));
    makeReadOnly(record);
    assert.equal(worktrees().length, 1);

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(record), false, result.stdout);
    assert.match(
      result.stdout,
      /removed stale worktree record \.git\/worktrees\/tree: its gitdir file is missing/,
    );
  });
});

// A stalled git (a fetch whose credential helper hangs) must not keep the cleanup, or the
// processes git started, running past the deadline (#12).
describe('worktrees-clean runGit with real git', () => {
  let dir: TempDir;
  let pidFile: string;
  beforeEach(() => {
    dir = makeTempDir('clean-git');
    pidFile = join(dir.path, 'pid').replaceAll('\\', '/');
  });
  // A failed assertion must not leave the sleeping child running. On Windows, git's killed tree
  // can hold the folder a moment longer; removeTree retries.
  afterEach(async () => {
    await killLeftovers(pidFile);
    removeTree(dir.path);
  });

  it('ends git and the processes it started at the deadline, and fails saying so', async () => {
    // A shell alias: git starts a shell, which starts node; node writes its pid and sleeps until
    // it is killed, longer than waitUntil waits, so only the kill of the tree can end it.
    const node = process.execPath.replaceAll('\\', '/');
    const sleeper = `require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1 << 30)`;
    // A loaded machine (#147): git's processes start later than the deadline expects, and the
    // kill takes effect late. So the test reaches the deadline once git's child is up, and waits
    // for the child to end instead of giving it a fixed time (ADR 0070).
    const deadline = cuedTimers();
    const loaded = gitThrough(runGitWith(execProcessWith(lateKill(2500), deadline)));

    const running = loaded(dir.path, ['-c', `alias.hang=!"${node}" -e "${sleeper}"`, 'hang'], {
      timeoutMs: 10,
    });
    await waitUntil('the child of git to start', () => pidIn(pidFile) !== undefined);
    deadline.fire();
    const result = await running;

    assert.equal(result.ok, false);
    assert.match(result.stderr, /timed out after 10 ms/);
    const pid = pidIn(pidFile) ?? 0;
    // The kill is late, so the child still runs: runGit answered without waiting for it.
    assert.ok(isPidAlive(pid), 'runGit waited for the child of git');
    await waitUntil('the child of git to end', () => !isPidAlive(pid));
  });
});
