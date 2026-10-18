// Real git for the git runner (ADR 0021): its timeout is a hard deadline that ends git and every
// process git started (a credential helper, ssh, gpg), which could otherwise keep running and
// hold git's output open.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { execProcessWith, isPidAlive } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { runGit, runGitWith } from '../../src/workspace/git.ts';
import { cuedTimers, waitUntil } from '../helpers/load.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { lateKill } from './late-kill.ts';
import { killLeftovers, pidIn } from './leftover-processes.ts';

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
    // A shell alias: git starts a shell, which starts node; node writes its pid and sleeps until
    // it is killed, longer than waitUntil waits, so only the kill of the tree can end it.
    const node = process.execPath.replaceAll('\\', '/');
    const script = `require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1 << 30)`;
    const hang = `alias.hang=!"${node}" -e "${script}"`;
    // A loaded machine (#147): git's processes start later than the deadline expects, and the
    // kill takes effect late. So the test reaches the deadline once git's child is up, and waits
    // for the child to end instead of giving it a fixed time (ADR 0070).
    const deadline = cuedTimers();
    const loaded = runGitWith(execProcessWith(lateKill(2500), deadline));

    const running = loaded(dir.path, ['-c', hang, 'hang'], { timeoutMs: 10 });
    await waitUntil('the child of git to start', () => pidIn(pidFile) !== undefined);
    deadline.fire();
    const result = await running;

    assert.equal(result.code, null);
    const pid = pidIn(pidFile) ?? 0;
    // The kill is late, so the child still runs: runGit answered without waiting for it.
    assert.ok(isPidAlive(pid), 'runGit waited for the child of git');
    await waitUntil('the child of git to end', () => !isPidAlive(pid));
  });
});
