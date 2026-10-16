// The platform layer against real processes, on every CI platform (#12): the runner kills a
// whole tree, grandchild included, at its deadline or when stopped; executables are found
// through PATH; a checked command line goes through cmd.exe intact.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { execProcess, isPidAlive, spawnProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { windowsCommandLine } from '../../src/platform/shell.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const tree = join(import.meta.dirname, '..', 'fixtures', 'processes', 'tree.ts');

const pidsIn = (file: string): number[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map(Number)
    : [];

const waitFor = async (what: string, done: () => boolean, ms = 20_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await delay(50);
  }
};

// taskkill and SIGKILL take effect at once, but give the OS a moment to reap. Kills what is
// left, so a failing test leaves nothing running.
const assertAllEnd = async (pids: number[]): Promise<void> => {
  const until = Date.now() + 10_000;
  while (pids.some((pid) => isPidAlive(pid)) && Date.now() < until) await delay(100);
  const alive = pids.filter((pid) => isPidAlive(pid));
  for (const pid of alive) process.kill(pid);
  assert.deepEqual(alive, [], 'processes of the tree still running');
};

describe('execProcess with a real tree of processes', () => {
  let dir: TempDir;
  let pidFile: string;
  beforeEach(() => {
    dir = makeTempDir('processes');
    pidFile = join(dir.path, 'pids');
  });
  // On Windows, a killed tree can hold the folder a moment longer; removeTree retries.
  afterEach(() => removeTree(dir.path));

  it('answers with the exit code and the output of a process that ends by itself', async () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
    const result = await execProcess(process.execPath, ['-e', script], { cwd: dir.path });
    assert.deepEqual(
      { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
      { exitCode: 3, stdout: 'out', stderr: 'err' },
    );
    assert.equal(result.killed, undefined);
  });

  it('kills the process, its child and its grandchild when stopped, and answers at once', async () => {
    const stop = new AbortController();
    const done = execProcess(process.execPath, [tree, pidFile, '2'], {
      cwd: dir.path,
      signal: stop.signal,
    });
    await waitFor('three levels to start', () => pidsIn(pidFile).length === 3);
    const stopped = Date.now();
    stop.abort();
    const result = await done;
    assert.ok(Date.now() - stopped < 5000, `answered ${Date.now() - stopped} ms after the stop`);
    assert.equal(result.killed, 'stopped');
    assert.equal(result.exitCode, null);
    assert.match(result.stdout, /level 2 started/);
    await assertAllEnd(pidsIn(pidFile));
  });

  it('kills the whole tree at the deadline, though the grandchild holds the output open', async () => {
    const started = Date.now();
    const result = await spawnProcess(process.execPath, [tree, pidFile, '2'], dir.path, {
      timeoutMs: 8000,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.killed, 'timed-out');
    assert.equal(result.exitCode, null);
    assert.ok(elapsed < 15_000, `answered after ${elapsed} ms`);
    const pids = pidsIn(pidFile);
    assert.equal(pids.length, 3, 'all three levels started before the deadline');
    await assertAllEnd(pids);
  });

  // #92: on Windows the runner answers as soon as its child exits, and taskkill /T would find the
  // tree only through a parent that is still alive, so the grandchild keeps running. The case
  // fails there until the runner holds its children in a Job Object (kill-on-close); it runs as a
  // todo, so CI shows it without failing. Elsewhere the grandchild holds the output open and the
  // deadline kills its process group. The levels left over end by themselves after 30 s, so the
  // test waits for them and never kills a pid itself: the exited parent's may be reused.
  it('leaves no process of the tree running when the parent exits before its grandchild', {
    todo:
      process.platform === 'win32'
        ? 'taskkill /T misses the children of an exited parent; needs a Job Object (#92)'
        : false,
  }, async () => {
    const done = spawnProcess(process.execPath, [tree, pidFile, '1', 'exit-parent'], dir.path, {
      timeoutMs: 6000,
    });
    await waitFor('the grandchild to start and its parent to exit', () => {
      const [parent, grandchild] = pidsIn(pidFile);
      return grandchild !== undefined && parent !== undefined && !isPidAlive(parent);
    });
    await done;
    const [, grandchild = 0] = pidsIn(pidFile);
    const until = Date.now() + 10_000;
    while (isPidAlive(grandchild) && Date.now() < until) await delay(100);
    assert.equal(isPidAlive(grandchild), false, `grandchild ${grandchild} still running`);
  });

  it('answers without an exit code when the program does not exist', async () => {
    const result = await execProcess(join(dir.path, 'no-such-program'), [], { cwd: dir.path });
    assert.equal(result.exitCode, null);
    assert.equal(result.killed, undefined);
    assert.match(result.output, /ENOENT/);
  });
});

describe('resolveExecutable on this machine', () => {
  it('finds git through PATH', () => {
    const git = resolveExecutable('git');
    assert.ok(git !== undefined && existsSync(git), String(git));
  });

  it('finds nothing for a name that is not installed', () => {
    assert.equal(resolveExecutable('foedrum-no-such-tool'), undefined);
  });
});

// A repository's own git.exe in the working directory must not run instead of the installed
// git (#12). The decoy is a copy of node, which answers --version with its own version.
describe('execProcess and a planted git.exe', { skip: process.platform !== 'win32' }, () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('decoy');
    copyFileSync(process.execPath, join(dir.path, 'git.exe'));
    copyFileSync(process.execPath, join(dir.path, 'git.com'));
  });
  afterEach(() => removeTree(dir.path));

  it('runs the git on PATH, not the git.exe or git.com in the working directory', async () => {
    const result = await execProcess('git', ['--version'], { cwd: dir.path });
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.stdout, /^git version /);
  });

  // A relative PATH folder means the working directory of the process that starts.
  it('runs the git on PATH, not the one a relative PATH folder points at', async () => {
    const env = { ...process.env, PATH: `.;${process.env.PATH ?? ''}` };
    const result = await execProcess('git', ['--version'], { cwd: dir.path, env });
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.stdout, /^git version /);
  });
});

describe('windowsCommandLine through cmd.exe', { skip: process.platform !== 'win32' }, () => {
  // A .cmd file that passes its arguments on to node with %*, as npm's claude.cmd does.
  const printArgs = join(import.meta.dirname, '..', 'fixtures', 'processes', 'print-args.cmd');
  const argsThrough = async (file: string, args: string[]): Promise<unknown> => {
    const line = windowsCommandLine(file, args);
    const child = spawn(line, [], { shell: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    return JSON.parse(stdout);
  };

  it('reaches the program behind a .cmd file with every argument intact', async () => {
    const args = [
      '-p',
      'C:\\Users\\Ann Lee\\settings.json',
      '',
      'C:\\Work Trees\\12\\',
      'José',
      '--output-format=stream-json',
      'a,b',
      'user@host',
      'a+b',
      '~x',
      'C:\\Program Files (x86)\\nodejs',
      "C:\\Users\\O'Brien",
    ];
    assert.deepEqual(await argsThrough(printArgs, args), args);
  });

  it('starts a .cmd file named with forward slashes', async () => {
    assert.deepEqual(await argsThrough(printArgs.replaceAll('\\', '/'), ['-p']), ['-p']);
  });
});

describe('execProcess and a .cmd file', { skip: process.platform !== 'win32' }, () => {
  // npm.cmd and npm's claude.cmd cannot start without cmd.exe; the runner goes through it.
  const printArgs = join(import.meta.dirname, '..', 'fixtures', 'processes', 'print-args.cmd');

  it('starts it through cmd.exe with every argument intact', async () => {
    const args = ['--version', 'C:\\Program Files (x86)\\nodejs', 'José', ''];
    const { exitCode, stdout } = await execProcess(printArgs, args, { cwd: import.meta.dirname });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout), args);
  });

  it('refuses an argument cmd.exe would read as syntax, without starting anything', async () => {
    const { exitCode, stderr } = await execProcess(printArgs, ['a & calc'], {
      cwd: import.meta.dirname,
    });
    assert.equal(exitCode, null);
    assert.match(stderr, /cannot go through the Windows shell/);
  });

  it('runs the node on PATH, not one planted in the working directory (#12)', async () => {
    // print-args.cmd runs a bare `node`, as npm's shims do; cmd.exe would look in the working
    // directory first.
    const planted = makeTempDir('planted');
    try {
      for (const name of ['node.cmd', 'node.bat']) {
        writeFileSync(join(planted.path, name), '@echo planted\r\n');
      }
      // Whatever the caller's environment says: some (a Claude Code session) set it already.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath',
        ),
      );
      const { exitCode, stdout } = await execProcess(printArgs, ['a'], { cwd: planted.path, env });
      // The real node printed the arguments as JSON; a planted one would print `planted`.
      assert.equal(stdout, '["a"]');
      assert.equal(exitCode, 0);
    } finally {
      planted.remove();
    }
  });
});
