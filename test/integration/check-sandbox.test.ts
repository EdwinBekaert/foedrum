// The check sandbox against the real bwrap and sandbox-exec (ADR 0076): a check's command line
// cannot write outside its worktree, read a file in the home folder or open a connection to a
// server on 127.0.0.1. It tests our arguments and profile with the real tools, not the tools
// themselves; it runs where the sandbox runs (macOS, Linux with a working bwrap) and skips elsewhere.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bwrapArgs, SANDBOX_EXEC, sandboxedChecks } from '../../src/platform/check-sandbox.ts';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { type ExecOptions, execProcess } from '../../src/platform/processes.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

/** Why the sandbox cannot run on this machine, or undefined when it can. */
const unavailable = (): string | undefined => {
  switch (process.platform) {
    case 'darwin':
      return existsSync(SANDBOX_EXEC) ? undefined : `${SANDBOX_EXEC} is not there`;
    case 'linux': {
      const bwrap = resolveExecutable('bwrap');
      if (bwrap === undefined) return 'bwrap is not on PATH';
      // Unprivileged namespaces may be off (a container, WSL 1, an AppArmor rule): probed with the
      // arguments a check gets, so the probe and the run agree.
      const probeDir = makeTempDir('check-sandbox-probe');
      try {
        const paths = { home: probeDir.path, worktree: probeDir.path, gitDir: undefined };
        const probe = spawnSync(bwrap, bwrapArgs(paths, 'true'), { timeout: 30_000 });
        if (probe.status === 0) return undefined;
        // bwrap's own line, such as Ubuntu's AppArmor refusing its user namespace.
        const said =
          String(probe.stderr ?? '')
            .trim()
            .split('\n')[0] ?? '';
        return `bwrap cannot make its sandbox here: ${said}`;
      } finally {
        probeDir.remove();
      }
    }
    default:
      return `no check sandbox on ${process.platform} (ADR 0076)`;
  }
};

const skip = unavailable();

describe('a check in the real sandbox', { skip: skip ?? false }, () => {
  let dir: TempDir;
  let home: string;
  let worktree: string;
  let outside: string;
  let run: ReturnType<typeof sandboxedChecks>;
  const check = (line: string) => {
    const call: ExecOptions = { cwd: worktree, shell: true, timeoutMs: 60_000 };
    return run(line, [], call);
  };

  before(() => {
    dir = makeTempDir('check-sandbox');
    home = join(dir.path, 'home');
    worktree = join(dir.path, 'worktree');
    outside = join(dir.path, 'outside');
    for (const folder of [home, worktree, outside]) mkdirSync(folder);
    writeFileSync(join(home, 'secret.txt'), 'planted-login\n');
    run = sandboxedChecks({ exec: execProcess, home });
  });
  after(() => dir.remove());

  it('writes in its worktree, and not outside it', async () => {
    const result = await check(`echo in > inside.txt && echo out > "${outside}/x.txt"`);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.ok(existsSync(join(worktree, 'inside.txt')), result.output);
    assert.ok(!existsSync(join(outside, 'x.txt')), result.output);
  });

  it('cannot read a file in the home folder', async () => {
    writeFileSync(join(worktree, 'own.txt'), 'own-text\n');
    const result = await check(`cat own.txt && cat "${home}/secret.txt"`);
    // It ran, read its worktree, and was refused the home folder.
    assert.match(result.output, /own-text/);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.doesNotMatch(result.output, /planted-login/);
  });

  // gh's login in the OS keyring (ADR 0073): the user's D-Bus socket under /run on Linux. The
  // macOS Keychain is not asked, inside the sandbox or out: no test reaches the OS keyring
  // (CLAUDE.md); the unit test pins the profile's denial.
  it('sees an empty /run on Linux, where the D-Bus socket was', {
    skip: process.platform !== 'linux' && 'the keyring socket is a Linux path',
  }, async () => {
    const result = await check('ls -A /run');
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.output.trim(), '');
  });

  it('cannot open a connection to a server on 127.0.0.1', async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    const reached = new Promise((done) => server.once('connection', done));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const connect = `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))`;
      const line = `"${process.execPath}" -e "${connect}"`;
      // The same line outside the sandbox reaches the server: the refusal is the sandbox's.
      const open = await execProcess(line, [], { cwd: worktree, shell: true, timeoutMs: 60_000 });
      assert.equal(open.exitCode, 0, open.output);
      await reached;
      const before = connections;
      const result = await check(line);
      // node ran, and its connection was refused.
      assert.equal(result.exitCode, 3, result.output);
      assert.equal(connections, before);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
