// The check sandbox (ADR 0076): a check's command line starts through bwrap on Linux and
// sandbox-exec on macOS with exactly these arguments, and as before on native Windows. A fake
// process runner records what would start (ADR 0021); whether the tools work is theirs.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  SANDBOX_EXEC,
  type SandboxedChecksOptions,
  SEATBELT_PROFILE,
  sandboxedChecks,
  worktreeGitDir,
} from '../../src/platform/check-sandbox.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const home = '/home/ada';
const worktree = '/home/ada/.foedrum/acme/attempts/12-1/green/1';
const gitDir = '/home/ada/.foedrum/acme/clones/acme.api/.git';
const line = 'npm test -- --reporter tap';
const env = { PATH: '/usr/bin', TMPDIR: '/var/tmp/ada' };
const signal = new AbortController().signal;
const call: ExecOptions = {
  cwd: worktree,
  env,
  timeoutMs: 60_000,
  signal,
  shell: true,
  jobObject: true,
  maxOutputBytes: 1024,
};

const fake = (answer: Partial<ExecResult> = {}) => {
  const calls: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
  const exec: ExecProcess = async (file, args, options) => {
    calls.push({ file, args, options });
    return { exitCode: 0, stdout: '', stderr: '', output: '', ...answer };
  };
  return { calls, exec };
};

const options = (exec: ExecProcess, more: Partial<SandboxedChecksOptions> = {}) => ({
  exec,
  home,
  findBwrap: () => '/usr/bin/bwrap',
  hasSandboxExec: () => true,
  realPath: (path: string) => path,
  gitDirOf: (path: string) => (path === worktree ? gitDir : undefined),
  ...more,
});

describe('sandboxedChecks on Linux and WSL2: bwrap', () => {
  it('starts the line through /bin/sh in bwrap, with no network, the home hidden and the worktree writable', async () => {
    const { calls, exec } = fake({ exitCode: 3, output: 'not ok 1\n' });
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    const result = await run(line, [], call);
    assert.equal(result.exitCode, 3);
    assert.deepEqual(calls, [
      {
        file: '/usr/bin/bwrap',
        args: [
          '--die-with-parent',
          '--unshare-pid',
          '--new-session',
          '--unshare-net',
          '--ro-bind',
          '/',
          '/',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '--tmpfs',
          '/run',
          '--tmpfs',
          home,
          '--ro-bind',
          gitDir,
          gitDir,
          '--bind',
          worktree,
          worktree,
          '--chdir',
          worktree,
          '--setenv',
          'TMPDIR',
          '/tmp',
          '/bin/sh',
          '-c',
          line,
        ],
        // The process runner's deadline, stop and limit as the caller gave them; no shell.
        options: { ...call, shell: false },
      },
    ]);
  });

  it('binds no repository when the worktree names none', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'linux', gitDirOf: () => undefined }));
    await run(line, [], call);
    assert.ok(!calls[0]?.args.includes(gitDir));
    assert.deepEqual(calls[0]?.args.slice(15, 21), [
      '--tmpfs',
      home,
      '--bind',
      worktree,
      worktree,
      '--chdir',
    ]);
  });

  it('binds the real paths of the home, the repository and the worktree', async () => {
    const { calls, exec } = fake();
    const real = (path: string) => `/real${path}`;
    const run = sandboxedChecks(options(exec, { platform: 'linux', realPath: real }));
    await run(line, [], call);
    const args = calls[0]?.args ?? [];
    assert.deepEqual(args.slice(15, 26), [
      '--tmpfs',
      `/real${home}`,
      '--ro-bind',
      `/real${gitDir}`,
      `/real${gitDir}`,
      '--bind',
      `/real${worktree}`,
      `/real${worktree}`,
      '--chdir',
      `/real${worktree}`,
      '--setenv',
    ]);
  });

  it('reads a bwrap that could not make its sandbox as a check that could not start, with its message', async () => {
    const stderr = 'bwrap: setting up uid map: Permission denied\n';
    const { exec } = fake({ exitCode: 1, stderr, output: stderr });
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    const result = await run(line, [], call);
    assert.equal(result.exitCode, null);
    assert.equal(result.killed, undefined);
    assert.match(result.output, /bwrap: setting up uid map: Permission denied/);
  });

  it('keeps a run the process runner killed as killed, whatever it printed', async () => {
    const stderr = 'bwrap: something\n';
    const { exec } = fake({ exitCode: 1, stderr, output: stderr, killed: 'timed-out' });
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    const result = await run(line, [], call);
    assert.equal(result.killed, 'timed-out');
    assert.equal(result.exitCode, 1);
  });

  it("keeps a check's own failure, whatever it prints", async () => {
    const output = 'not ok 1 - bwrap: not mentioned first\n';
    const { exec } = fake({ exitCode: 1, stdout: output, output });
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    assert.equal((await run(line, [], call)).exitCode, 1);
  });

  it('does not run the line when a path cannot be resolved: it could not start, and says why', async () => {
    const { calls, exec } = fake();
    const realPath = (): string => {
      throw new Error('EACCES: permission denied');
    };
    const run = sandboxedChecks(options(exec, { platform: 'linux', realPath }));
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /EACCES/);
  });

  it('does not run the line without bwrap: it could not start, and says why', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'linux', findBwrap: () => undefined }));
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.equal(result.exitCode, null);
    assert.equal(result.killed, undefined);
    assert.match(result.output, /bubblewrap \(bwrap\) is not on PATH.*\(ADR 0076\)/);
  });
});

describe('sandboxedChecks on macOS: sandbox-exec', () => {
  const temp = '/private/var/folders/x/T/foedrum-check-1';
  const folders = () => {
    const removed: string[] = [];
    return {
      removed,
      temp: {
        make: () => temp,
        remove: async (path: string) => {
          removed.push(path);
        },
      },
    };
  };

  it('starts the line through /bin/sh under the profile, the paths as parameters, in a temporary home', async () => {
    const { calls, exec } = fake();
    const { removed, temp: made } = folders();
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp: made }));
    await run(line, [], call);
    assert.deepEqual(calls, [
      {
        file: SANDBOX_EXEC,
        args: [
          '-D',
          `HOME=${home}`,
          '-D',
          `WORKTREE=${worktree}`,
          '-D',
          `GIT_DIR=${gitDir}`,
          '-D',
          `TEMP=${temp}`,
          '-p',
          SEATBELT_PROFILE,
          '/bin/sh',
          '-c',
          line,
        ],
        options: { ...call, shell: false, env: { ...env, TMPDIR: temp, HOME: temp } },
      },
    ]);
    assert.deepEqual(removed, [temp]);
  });

  it('denies the network, the Keychain, writes outside the worktree and the temp folder, and reads of the home', () => {
    assert.equal(
      SEATBELT_PROFILE,
      [
        '(version 1)',
        '(allow default)',
        '(deny network*)',
        '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
        // launchd and LaunchServices start what they are asked to outside the sandbox.
        '(deny job-creation)',
        '(deny lsopen)',
        '(deny appleevent-send)',
        '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
        '(deny file-write*)',
        '(allow file-write* (subpath (param "WORKTREE")) (subpath (param "TEMP")) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/"))',
        '(deny file-read* (subpath (param "HOME")))',
        '(allow file-read* (subpath (param "WORKTREE")) (subpath (param "GIT_DIR")))',
        '',
      ].join('\n'),
    );
  });

  it('gives the worktree as the repository when it names none', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(
      options(exec, { platform: 'darwin', gitDirOf: () => undefined, temp: folders().temp }),
    );
    await run(line, [], call);
    assert.equal(calls[0]?.args[5], `GIT_DIR=${worktree}`);
  });

  it('removes the temporary folder also when the run throws', async () => {
    const { removed, temp: made } = folders();
    const run = sandboxedChecks(
      options(() => Promise.reject(new Error('spawn failed')), { platform: 'darwin', temp: made }),
    );
    await assert.rejects(run(line, [], call), /spawn failed/);
    assert.deepEqual(removed, [temp]);
  });

  it('reads a sandbox-exec that could not apply its profile as a check that could not start', async () => {
    const stderr = 'sandbox-exec: sandbox_apply: Operation not permitted\n';
    const { exec } = fake({ exitCode: 71, stderr, output: stderr });
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp: folders().temp }));
    const result = await run(line, [], call);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /sandbox-exec: sandbox_apply: Operation not permitted/);
  });

  it("keeps the check's result when its temporary folder cannot be removed, and says so", async () => {
    const { exec } = fake({ exitCode: 1, output: 'not ok 1\n' });
    const temp = {
      make: () => '/private/var/folders/x/T/foedrum-check-2',
      remove: (): Promise<void> => Promise.reject(new Error('EPERM: operation not permitted')),
    };
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp }));
    const result = await run(line, [], call);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^not ok 1\n/);
    assert.match(result.output, /foedrum-check-2.*EPERM/);
  });

  it('does not run the line when its temporary folder cannot be made: it could not start, and says why', async () => {
    const { calls, exec } = fake();
    const { removed } = folders();
    const temp = {
      make: (): string => {
        throw new Error('ENOSPC: no space left on device');
      },
      remove: async (path: string) => {
        removed.push(path);
      },
    };
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp }));
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.deepEqual(removed, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /ENOSPC/);
  });

  it('does not run the line without sandbox-exec: it could not start, and says why', async () => {
    const { calls, exec } = fake();
    const { removed, temp: made } = folders();
    const run = sandboxedChecks(
      options(exec, { platform: 'darwin', hasSandboxExec: () => false, temp: made }),
    );
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.deepEqual(removed, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /\/usr\/bin\/sandbox-exec is not there.*\(ADR 0076\)/);
  });
});

describe('sandboxedChecks elsewhere', () => {
  it('runs the line as before on native Windows, which has no sandbox for shell commands', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'win32' }));
    await run(line, [], call);
    assert.deepEqual(calls, [{ file: line, args: [], options: call }]);
  });

  it('passes a call that is no command line on as it is', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    await run('git', ['status'], { cwd: worktree });
    assert.deepEqual(calls, [{ file: 'git', args: ['status'], options: { cwd: worktree } }]);
  });
});

describe('worktreeGitDir', () => {
  /** A worktree folder whose `.git` holds `text`, or is a folder when `text` is undefined. */
  const worktreeWith = (text: string | undefined) => {
    const dir = makeTempDir('git-dir');
    const path = join(dir.path, 'worktree');
    mkdirSync(path);
    if (text === undefined) mkdirSync(join(path, '.git'));
    else writeFileSync(join(path, '.git'), text);
    return { dir, path };
  };

  /** A repository with the record of a linked worktree whose `gitdir` file holds `back`. */
  const recordIn = (dir: string, back: string) => {
    const repository = join(dir, 'clone', '.git');
    const record = join(repository, 'worktrees', 'green-1');
    mkdirSync(record, { recursive: true });
    writeFileSync(join(record, 'gitdir'), `${back}\n`);
    return { repository, record };
  };

  it("names the repository a linked worktree's record sits in, when the record names the worktree back", () => {
    const { dir } = worktreeWith(undefined);
    try {
      const { repository, record } = recordIn(dir.path, join(dir.path, 'linked', '.git'));
      const linked = join(dir.path, 'linked');
      mkdirSync(linked);
      writeFileSync(join(linked, '.git'), `gitdir: ${record}\n`);
      assert.equal(worktreeGitDir(linked), repository);
    } finally {
      dir.remove();
    }
  });

  // A check writes its worktree, `.git` included: a later check of the step must not get the
  // home folder or /run bound back in by naming it there (review of #357).
  it('names none when the record does not name the worktree back, as a rewritten .git would', () => {
    const { dir, path } = worktreeWith(undefined);
    try {
      const { record } = recordIn(dir.path, join(dir.path, 'other', '.git'));
      const forged = join(dir.path, 'forged');
      mkdirSync(forged);
      writeFileSync(join(forged, '.git'), `gitdir: ${record}\n`);
      assert.equal(worktreeGitDir(forged), undefined);
      // A folder that is no worktree record, such as the home folder.
      writeFileSync(join(forged, '.git'), `gitdir: ${join(dir.path, 'home')}\n`);
      assert.equal(worktreeGitDir(forged), undefined);
      assert.equal(worktreeGitDir(path), undefined);
    } finally {
      dir.remove();
    }
  });

  // git writes the record with the real path; serve may name the worktree through a link, as
  // where /home links to /var/home (review of #357).
  it('names the repository when the worktree is reached through a link to where git recorded it', () => {
    const { dir } = worktreeWith(undefined);
    try {
      const real = join(dir.path, 'real');
      const linked = join(real, 'linked');
      mkdirSync(linked, { recursive: true });
      const { repository, record } = recordIn(dir.path, join(linked, '.git'));
      writeFileSync(join(linked, '.git'), `gitdir: ${record}\n`);
      const link = join(dir.path, 'link');
      symlinkSync(real, link, 'junction');
      assert.equal(worktreeGitDir(join(link, 'linked')), repository);
    } finally {
      dir.remove();
    }
  });

  it('names none for a repository inside the worktree, which is bound with it', () => {
    const { dir, path } = worktreeWith(undefined);
    try {
      assert.equal(worktreeGitDir(path), undefined);
    } finally {
      dir.remove();
    }
  });

  it('resolves a relative record against the worktree, and names none outside worktrees/', () => {
    const { dir, path } = worktreeWith('gitdir: ../clone/.git/worktrees/green-1\r\n');
    try {
      const { repository } = recordIn(dir.path, join(path, '.git'));
      assert.equal(worktreeGitDir(path), repository);
      writeFileSync(join(path, '.git'), 'gitdir: ../repo.git\n');
      assert.equal(worktreeGitDir(path), undefined);
    } finally {
      dir.remove();
    }
  });

  it('names none without a .git file, or one that names no gitdir', () => {
    const { dir, path } = worktreeWith('not a gitdir line');
    try {
      assert.equal(worktreeGitDir(path), undefined);
      assert.equal(worktreeGitDir(join(dir.path, 'missing')), undefined);
    } finally {
      dir.remove();
    }
  });
});
