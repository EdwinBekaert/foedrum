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
import { jobObjectCommand } from '../../src/platform/job-object.ts';
import {
  execProcess,
  execProcessWith,
  isPidAlive,
  processSpawner,
  type Spawner,
  spawnCommand,
  spawnProcess,
  streamProcess,
} from '../../src/platform/processes.ts';
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

  // A hook or a credential helper that writes without end (#91). Each write waits for the pipe,
  // so the writer runs on every platform until it is killed.
  it('kills a process that writes without end once its output passes the limit', async () => {
    const script =
      "process.stdout.write(process.pid + '\\n'); const chunk = 'x'.repeat(65536);" +
      ' const more = () => process.stdout.write(chunk, more); more();';
    const started = Date.now();
    const result = await execProcess(process.execPath, ['-e', script], {
      cwd: dir.path,
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.killed, 'too-much-output');
    assert.equal(result.exitCode, null);
    assert.ok(elapsed < 10_000, `answered after ${elapsed} ms`);
    assert.ok(result.output.length <= 1024 * 1024, String(result.output.length));
    await assertAllEnd([Number(result.stdout.split('\n')[0])]);
  });

  // #92: on Windows taskkill /T finds the tree only through a parent that is still alive, so a
  // grandchild whose parent has exited would keep running. The runner holds the tree in a
  // kill-on-close Job Object instead (ADR 0039), which ends it when the parent exits. Elsewhere
  // the grandchild holds the output open and the deadline kills its process group. The levels
  // left over end by themselves after 30 s, so the test waits for them and never kills a pid
  // itself: the exited parent's may be reused.
  it('leaves no process of the tree running when the parent exits before its grandchild', async () => {
    // Run outside dir.path: on Windows a surviving orphan's working directory could not be
    // removed after the test.
    const cwd = import.meta.dirname;
    const done = spawnProcess(process.execPath, [tree, pidFile, '1', 'exit-parent'], cwd, {
      timeoutMs: 6000,
      jobObject: true,
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

// The line-by-line runner the brewer runner reads claude's stream with (ADR 0045).
describe('streamProcess with real processes', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('stream');
  });
  afterEach(() => removeTree(dir.path));

  // Echoes stdin as a line, then writes `count` lines of 32 KiB: 5 MiB in all, past the 4 MiB that
  // execProcess holds (ADR 0035).
  const writer =
    "let input = ''; process.stdin.setEncoding('utf8').on('data', (c) => { input += c; });" +
    " process.stdin.on('end', () => { process.stdout.write(JSON.stringify(input) + '\\n');" +
    " const line = 'x'.repeat(32 * 1024 - 1) + '\\n'; let left = Number(process.argv[1]);" +
    ' const more = () => { while (left > 0) { left -= 1; if (!process.stdout.write(line))' +
    " { process.stdout.once('drain', more); return; } } }; more(); });";

  for (const jobObject of process.platform === 'win32' ? [false, true] : [false]) {
    it(`reads stdin, and hands over every line of 5 MiB of stdout${jobObject ? ', in a Job Object' : ''}`, async () => {
      const lines: string[] = [];
      const result = await streamProcess(process.execPath, ['-e', writer, '160'], {
        cwd: dir.path,
        stdin: 'a prompt ✓ "quoted"\non two lines',
        maxLineBytes: 64 * 1024,
        timeoutMs: 60_000,
        jobObject,
        onLine: (line) => lines.push(line.length > 40 ? String(line.length) : line),
      });
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.equal(lines[0], JSON.stringify('a prompt ✓ "quoted"\non two lines'));
      assert.equal(lines.length, 161);
      assert.ok(lines.slice(1).every((line) => line === String(32 * 1024 - 1)));
    });
  }

  it('kills a process that writes a line without end once the line passes the limit', async () => {
    const script =
      "process.stdout.write(process.pid + '\\n'); const chunk = 'x'.repeat(65536);" +
      ' const more = () => process.stdout.write(chunk, more); more();';
    const lines: string[] = [];
    const started = Date.now();
    const result = await streamProcess(process.execPath, ['-e', script], {
      cwd: dir.path,
      maxLineBytes: 1024 * 1024,
      timeoutMs: 20_000,
      onLine: (line) => lines.push(line),
    });
    const elapsed = Date.now() - started;
    assert.equal(result.killed, 'line-too-long');
    assert.equal(result.exitCode, null);
    assert.ok(elapsed < 10_000, `answered after ${elapsed} ms`);
    assert.equal(lines.length, 1);
    await assertAllEnd([Number(lines[0])]);
  });
});

// The Job Object helper (ADR 0039) with real processes: Windows PowerShell holds the program in
// a kill-on-close job, which the kernel closes when the helper ends.
describe('execProcess in a Job Object', { skip: process.platform !== 'win32' }, () => {
  let dir: TempDir;
  let pidFile: string;
  beforeEach(() => {
    dir = makeTempDir('job-object');
    pidFile = join(dir.path, 'pids');
  });
  afterEach(() => removeTree(dir.path));

  it('answers with the exit code and output, every argument intact, in the working directory', async () => {
    const script =
      'process.stdout.write(JSON.stringify([process.argv.slice(1), process.cwd()]));' +
      " process.stderr.write('err'); process.exit(7)";
    const args = ['a b', 'c"d', '', 'trailing\\', 'José'];
    const result = await execProcess(process.execPath, ['-e', script, ...args], {
      cwd: dir.path,
      jobObject: true,
    });
    assert.deepEqual(
      { exitCode: result.exitCode, stdout: JSON.parse(result.stdout), stderr: result.stderr },
      { exitCode: 7, stdout: [args, dir.path], stderr: 'err' },
    );
  });

  // The program gets exactly the caller's environment, never the helper's: Windows PowerShell gives
  // itself PSModulePath and PATHEXT when it has none, and a later version may add others. Only the
  // names of the variables that differ are compared, so a failure never prints a value of the
  // environment (a token, in CI).
  it("gives the program exactly the caller's environment, not PowerShell's", async () => {
    const script = 'process.stdout.write(JSON.stringify(process.env))';
    const caller: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !['psmodulepath', 'pathext'].includes(entry[0].toLowerCase()),
      ),
    );
    for (const env of [
      caller,
      { ...caller, PSModulePath: 'C:\\only\\mine', FOEDRUM_PROBE: 'José ✓ "quoted" = sign' },
    ]) {
      const result = await execProcess(process.execPath, ['-e', script], {
        cwd: dir.path,
        env,
        jobObject: true,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      const held: Record<string, string> = JSON.parse(result.stdout);
      const names = new Set([...Object.keys(env), ...Object.keys(held)]);
      const differ = [...names].filter((name) => env[name] !== held[name]);
      assert.deepEqual(differ, []);
    }
  });

  it('passes on an exit code above 2^31, as Windows reports a crash', async () => {
    const result = await execProcess(process.execPath, ['-e', 'process.exit(3221225786)'], {
      cwd: dir.path,
      jobObject: true,
    });
    assert.equal(result.exitCode, 3221225786);
  });

  it('starts a .cmd file through cmd.exe with every argument intact', async () => {
    const printArgs = join(import.meta.dirname, '..', 'fixtures', 'processes', 'print-args.cmd');
    const args = ['--version', 'C:\\Program Files (x86)\\nodejs', ''];
    const result = await execProcess(printArgs, args, { cwd: dir.path, jobObject: true });
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(JSON.parse(result.stdout), args);
  });

  // The job, not taskkill: a kill of the helper alone, with no tree walk, must end every level.
  // The levels are detached, so no node holds the next in a job of its own, as cmd.exe does not;
  // the levels left over end by themselves after 30 s.
  it('ends the whole tree when only the helper is killed', async () => {
    const exec = execProcessWith({ ...processSpawner, killTree: (pid) => process.kill(pid) });
    const stop = new AbortController();
    const done = exec(process.execPath, [tree, pidFile, '2', 'orphan'], {
      cwd: dir.path,
      signal: stop.signal,
      jobObject: true,
    });
    await waitFor('three levels to start', () => pidsIn(pidFile).length === 3);
    stop.abort();
    assert.equal((await done).killed, 'stopped');
    await assertAllEnd(pidsIn(pidFile));
  });

  // Fail closed: nothing runs outside a job when the helper cannot make one. The reason is the
  // failed call's own: 267, ERROR_DIRECTORY, in any language Windows speaks.
  it('starts nothing, and says why, when the program cannot start', async () => {
    const result = await execProcess(process.execPath, ['-e', ''], {
      cwd: join(dir.path, 'no-such-folder'),
      jobObject: true,
    });
    assert.equal(result.exitCode, null);
    assert.match(
      result.stderr,
      /node\.exe: cannot run in a Job Object: CreateProcess: .+ \(267\)$/,
    );
  });

  // The real spawner, with the helper's script edited first: how a test puts PowerShell in a state
  // it cannot otherwise reach.
  const editedHelper = (edit: (script: string) => string): Spawner => ({
    ...processSpawner,
    spawn: (file, args, { cwd, env }) => {
      const helper = jobObjectCommand(spawnCommand(file, args, 'win32', env), cwd);
      const script = Buffer.from(helper.args.at(-1) ?? '', 'base64').toString('utf16le');
      const edited = edit(script);
      assert.notEqual(edited, script, 'the edit must change the script');
      return spawn(
        helper.file,
        [...helper.args.slice(0, -1), Buffer.from(edited, 'utf16le').toString('base64')],
        {
          cwd: helper.cwd,
          env: helper.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    },
  });

  // Where a policy keeps PowerShell in Constrained Language Mode, no job can be made. The mode is
  // switched on at the start of the helper's own script, as such a policy would have it.
  it('starts nothing, and says why, in Constrained Language Mode', async () => {
    const constrained = editedHelper(
      (script) => `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n${script}`,
    );
    const result = await execProcessWith(constrained)(process.execPath, ['-e', ''], {
      cwd: dir.path,
      jobObject: true,
    });
    assert.equal(result.exitCode, null);
    assert.match(
      result.stderr,
      /cannot run in a Job Object: PowerShell runs in ConstrainedLanguage mode/,
    );
  });

  // A failure after the program exists but before it runs: the suspended program would hold the
  // output open, so the helper ends it and the call answers at once, not at its deadline. Runs
  // outside dir.path, whose removal such a program would block.
  // The same through the helper's own failure path: a job the program cannot be assigned to.
  it('ends the program it could not put in the job, and answers at once', async () => {
    const failing = editedHelper((script) =>
      script.replace(
        '$k::AssignProcessToJobObject($job, $process)',
        '$k::AssignProcessToJobObject([IntPtr]::Zero, $process)',
      ),
    );
    const started = Date.now();
    const result = await execProcessWith(failing)(process.execPath, ['-e', ''], {
      cwd: import.meta.dirname,
      timeoutMs: 30_000,
      jobObject: true,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.killed, undefined, `answered after ${elapsed} ms`);
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /cannot run in a Job Object: AssignProcessToJobObject: .+ \(6\)$/);
    assert.ok(elapsed < 15_000, `answered after ${elapsed} ms`);
  });

  it('ends the program it could not let run, and answers at once', async () => {
    const failing = editedHelper((script) =>
      script.replace(
        '$thread = & $read $started $size',
        "$thread = & $read $started $size\nthrow 'injected'",
      ),
    );
    const started = Date.now();
    const result = await execProcessWith(failing)(process.execPath, ['-e', ''], {
      cwd: import.meta.dirname,
      timeoutMs: 30_000,
      jobObject: true,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.killed, undefined, `answered after ${elapsed} ms`);
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /cannot run in a Job Object: injected/);
    assert.ok(elapsed < 15_000, `answered after ${elapsed} ms`);
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
