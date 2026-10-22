// The check sandbox (ADR 0076): a check's command line starts through bwrap on Linux and
// sandbox-exec on macOS with exactly these arguments, and as before on native Windows. A fake
// process runner records what would start (ADR 0021); whether the tools work is theirs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SANDBOX_EXEC,
  type SandboxedChecksOptions,
  SEATBELT_PROFILE,
  sandboxedChecks,
} from '../../src/platform/check-sandbox.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';

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
        '(deny file-write*)',
        '(allow file-write* (subpath (param "WORKTREE")) (subpath (param "TEMP")) (literal "/dev/null"))',
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
