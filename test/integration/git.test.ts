// Real git for the git runner (ADR 0021): its timeout is a hard deadline that ends git and every
// process git started (a credential helper, ssh, gpg), which could otherwise keep running and
// hold git's output open.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { runGit } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { killLeftovers } from './leftover-processes.ts';

describe('runGit with real git', () => {
  let dir: TempDir;
  let pidFile: string;
  beforeEach(() => {
    dir = makeTempDir('git');
    pidFile = join(dir.path, 'pid').replaceAll('\\', '/');
  });
  // A failed assertion must not leave the sleeping child running. On Windows, git's killed tree
  // can hold the folder a moment longer; removeTree retries.
  afterEach(async () => {
    await killLeftovers(pidFile);
    removeTree(dir.path);
  });

  it('answers with git output and exit code', async () => {
    const result = await runGit(dir.path, ['--version']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^git version /);
  });

  it('ends git and the processes it started at the timeout', async () => {
    // A shell alias: git starts a shell, which starts node; node writes its pid and sleeps.
    const node = process.execPath.replaceAll('\\', '/');
    const script = `require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 60000)`;
    const hang = `alias.hang=!"${node}" -e "${script}"`;
    const started = Date.now();

    const result = await runGit(dir.path, ['-c', hang, 'hang'], { timeoutMs: 2000 });

    const elapsed = Date.now() - started;
    assert.equal(result.code, null);
    assert.ok(elapsed < 10_000, `runGit returned after ${elapsed} ms`);
    assert.ok(existsSync(pidFile), 'the child of git started');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    // taskkill and SIGKILL take effect at once, but give the OS a moment to reap.
    for (let i = 0; i < 20 && isPidAlive(pid); i++) await delay(100);
    const alive = isPidAlive(pid);
    if (alive) process.kill(pid);
    assert.equal(alive, false, 'the child of git was left running');
  });
});
