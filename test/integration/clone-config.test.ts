// The engine's network git ignores the clone's configuration (ADR 0096), with real git: a bare
// origin, the user's clone with a key planted in its configuration, as a brewer could from the
// worktree that shares it (#200), and the push, the ls-remote and the worktree manager's fetch,
// which each reach the origin by the URL Foedrum names and run none of the planted commands.
// The one server is a local one that asks for a login: nothing reaches the network.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { removeTree } from '../../src/platform/remove.ts';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
import { openBranchPush } from '../../src/workspace/branch-push-git.ts';
import { inClone } from '../../src/workspace/clone-git.ts';
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

/** What each planted command writes to: one line per run, naming the command. */
const MARK = `import { appendFileSync } from 'node:fs';
appendFileSync(new URL('./marks.txt', import.meta.url), process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`;

describe("the engine's network git and the clone's configuration (ADR 0096)", () => {
  let dir: TempDir;
  // A server that answers every request with a demand for a login, so git asks the credential
  // helpers of whatever configuration it reads.
  let server: Server;
  let login: string;
  before(async () => {
    dir = makeTempDir('clone-config');
    server = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="foedrum"' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    login = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acme/app.git`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await removeTree(dir.path);
  });

  let runs = 0;
  let run: string;
  let origin: string;
  let user: string;
  let other: string;
  let marks: string;
  /** The planted commands' script, as a command line git's shell reads on every platform. */
  let mark: string;
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
    const script = join(run, 'mark.mjs');
    writeFileSync(script, MARK);
    marks = join(run, 'marks.txt');
    mark = `node "${script.replaceAll('\\', '/')}"`;
  });

  /** Commits `name` in `path` and returns the commit. */
  const commit = (path: string, name: string): string => {
    writeFileSync(join(path, name), `${name}\n`);
    git(path, ['add', name]);
    git(path, ['commit', '-q', '-m', name]);
    return git(path, ['rev-parse', 'HEAD']).trim();
  };

  /** A path where no repository is: git fails there, and nothing can land in it. */
  const nowhere = () => join(run, 'nowhere.git');

  /** Each key of #200, as a brewer could plant it in the clone's configuration. */
  const plants: Record<string, (clone: string) => void> = {
    "credential.helper, with the origin's URL at a server that asks for a login": (clone) => {
      git(clone, ['config', 'remote.origin.url', login]);
      git(clone, ['config', 'credential.helper', `!${mark} credential.helper`]);
    },
    "core.sshCommand, with the origin's URL over ssh": (clone) => {
      git(clone, ['config', 'remote.origin.url', 'ssh://git@foedrum.invalid/acme/app.git']);
      git(clone, ['config', 'core.sshCommand', `${mark} core.sshCommand`]);
    },
    "core.askPass, with the origin's URL at a server that asks for a login": (clone) => {
      git(clone, ['config', 'remote.origin.url', login]);
      git(clone, ['config', 'core.askPass', `${mark} core.askPass`]);
    },
    "url.<nowhere>.pushInsteadOf of the origin's URL": (clone) => {
      git(clone, ['config', `url.${nowhere()}.pushInsteadOf`, origin]);
    },
    'remote.origin.pushurl': (clone) => {
      git(clone, ['config', 'remote.origin.pushurl', nowhere()]);
    },
    "url.<nowhere>.insteadOf of the origin's URL": (clone) => {
      git(clone, ['config', `url.${nowhere()}.insteadOf`, origin]);
    },
    'include.path of a file that redirects the origin': (clone) => {
      const included = join(run, 'included.gitconfig');
      writeFileSync(included, '');
      git(run, ['config', '--file', included, `url.${nowhere()}.insteadOf`, origin]);
      git(clone, ['config', 'include.path', included]);
    },
    'core.hooksPath': (clone) => {
      const hooks = join(run, 'hooks');
      mkdirSync(hooks);
      for (const hook of ['pre-push', 'reference-transaction', 'post-checkout', 'post-update']) {
        writeFileSync(join(hooks, hook), `#!/bin/sh\n${mark} hook ${hook}\nexit 1\n`);
        chmodSync(join(hooks, hook), 0o755);
      }
      git(clone, ['config', 'core.hooksPath', hooks]);
    },
  };

  for (const [plant, write] of Object.entries(plants)) {
    it(`pushes, lists and fetches by the URL Foedrum names, past ${plant}`, async () => {
      const tip = commit(user, 'plan.txt');
      write(user);
      const push = openBranchPush({
        git: runGit,
        clone: user,
        own: { url: origin, root: join(run, 'git') },
      });
      assert.equal(await push.remoteTip(bottle), undefined);
      await push.push(tip, bottle);
      assert.equal(git(origin, ['rev-parse', `refs/heads/${bottle}`]).trim(), tip);
      assert.equal(await push.remoteTip(bottle), tip);

      // Main moves on in another clone; the next attempt starts at it.
      const main = commit(other, 'merged.txt');
      git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      const worktrees = openAttemptWorktrees({
        git: runGit,
        workRoot: join(run, 'work'),
        repo: 'acme/app',
        clone: user,
        own: { url: origin, root: join(run, 'git') },
      });
      const made = await worktrees.create(attempt, 'origin/main');
      assert.equal(made.commit, main);
      assert.equal(git(user, ['rev-parse', 'refs/remotes/origin/main']).trim(), main);

      assert.equal(existsSync(marks) ? readFileSync(marks, 'utf8') : '', '');
      assert.equal(existsSync(nowhere()), false);
    });
  }

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
    // A brewer redirects the clone's origin: the push goes where Foedrum says all the same.
    git(managed, ['config', `url.${nowhere()}.insteadOf`, url]);
    await openBranchPush({ git: runGit, clone: managed, own }).push(tip, bottle);
    assert.equal(git(served, ['rev-parse', `refs/heads/${bottle}`]).trim(), tip);
  });

  it('reads a blobless clone with no lazy fetch, so a promisor remote a brewer points at its own ssh command never runs (review of #266)', async () => {
    const served = join(run, 'served.git');
    git(run, ['clone', '-q', '--bare', origin, served]);
    git(served, ['config', 'uploadpack.allowFilter', 'true']);
    const managed = join(run, 'clone.git');
    git(run, ['clone', '-q', '--bare', '--filter=blob:none', pathToFileURL(served).href, managed]);
    const blob = git(served, ['rev-parse', 'main:readme.txt']).trim();
    // The promisor remote over ssh, its command the brewer's, and ssh allowed for it by name.
    git(managed, ['config', 'remote.origin.url', 'ssh://git@foedrum.invalid/acme/app.git']);
    git(managed, ['config', 'core.sshCommand', `${mark} core.sshCommand`]);
    git(managed, ['config', 'protocol.ssh.allow', 'always']);
    const read = await inClone(runGit)(managed, ['cat-file', '-p', blob]);
    assert.notEqual(read.code, 0);
    assert.equal(existsSync(marks) ? readFileSync(marks, 'utf8') : '', '');
  });
});
