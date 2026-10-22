// `foedrum serve` on the real machine (ADR 0063), with a fake git and fake signals: which signals
// stop it, and where each repository's attempt worktrees come from (a local clone, or a managed
// clone made from GitHub that borrows the local clone's objects). No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type ServeRepository, type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../../src/cli/serve-shell.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { fakeGit, suiteFolders } from '../helpers/attempt-worktrees.ts';
import { clone, local, serveInputs } from '../helpers/serve-brewery.ts';

describe('serveShell', () => {
  const nextFolder = suiteFolders('serve-shell');
  let workRoot: string;
  let setup: ServeSetup;
  beforeEach(() => {
    workRoot = nextFolder();
    const result = serveSetup(
      serveInputs({ files: { ...serveInputs().files, local: local({ workRoot }) } }),
    );
    setup = result.kind === 'ready' ? result.setup : assert.fail();
  });
  const web = (fields: Partial<ServeRepository> = {}): ServeRepository => ({
    repo: 'acme/web',
    source: 'local',
    base: 'origin/main',
    clone,
    tools: [],
    checks: { build: null, typecheck: null, lint: null, format: null, test: null },
    ...fields,
  });
  const listening = () => {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      listen: (name: NodeJS.Signals, handler: () => void) => handlers.set(name, handler),
    };
  };

  it('stops on Ctrl+C, a kill, a closed terminal and Ctrl+Break', () => {
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      const { handlers, listen } = listening();
      const shell = serveShell(setup, {
        root: 'brewery',
        git: fakeGit().git,
        out: () => {},
        listen,
      });
      assert.deepStrictEqual([...handlers.keys()].sort(), [
        'SIGBREAK',
        'SIGHUP',
        'SIGINT',
        'SIGTERM',
      ]);
      assert.equal(shell.signal.aborted, false);
      handlers.get(name)?.();
      assert.equal(shell.signal.aborted, true, name);
    }
  });

  it("opens a local repository's worktrees in the user's clone, cloning nothing", async () => {
    const { calls, git } = fakeGit();
    const shell = serveShell(setup, { root: 'brewery', git, out: () => {}, listen: () => {} });
    const manager = await shell.worktrees(web());
    assert.equal(manager.root, join(workRoot, 'acme.web', 'attempts'));
    assert.deepStrictEqual(calls, []);
  });

  it("starts a check step's command line in the OS sandbox, never as it is (ADR 0076)", async () => {
    const { git } = fakeGit();
    const started: string[] = [];
    const checks = {
      exec: async (file: string) => {
        started.push(file);
        return { exitCode: 0, stdout: '', stderr: '', output: '' };
      },
      platform: 'linux' as const,
      findBwrap: () => '/usr/bin/bwrap',
      realPath: (path: string) => path,
      gitDirOf: () => undefined,
      home: '/home/brewer',
    };
    const shell = serveShell(setup, {
      root: 'brewery',
      git,
      out: () => {},
      listen: () => {},
      checks,
    });
    await shell.exec('npm test', [], { cwd: '/work/wt', shell: true });
    assert.deepStrictEqual(started, ['/usr/bin/bwrap']);
  });

  const managed = () => join(workRoot, 'acme.web', 'clone.git');
  const gitDirs = () => join(workRoot, 'acme.web', 'git-dirs');
  const github = 'https://github.com/acme/web.git';
  /** Where each call of `command` ran, its git directory's folder and the URL it reached. */
  const reached = (calls: string[][], command: string) =>
    calls
      .filter((call) => call.includes(command))
      .map((call) => [call[0], dirname(call[1]?.slice('--git-dir='.length) ?? ''), call.at(-2)]);
  /** The clone whose objects each git directory of Foedrum's own was made for. */
  const objectsOf = (calls: string[][]) =>
    calls.filter((call) => call.includes('--show-object-format')).map((call) => call[0]);

  it("pushes from the user's clone of a local repository, and from the managed clone, by its origin (ADR 0071, ADR 0137)", async () => {
    const tip = 'c'.repeat(40);
    const branch = 'foedrum/acme.brewery/12-1/acme.web';
    const { calls, git } = fakeGit();
    const shell = serveShell(setup, { root: 'brewery', git, out: () => {}, listen: () => {} });
    await shell.push(web()).push(tip, branch);
    await shell.push(web({ source: 'managed' })).push(tip, branch);
    assert.deepStrictEqual(
      calls.filter((call) => call.includes('push')).map((call) => [call[0], call.at(-2)]),
      [
        [clone, 'origin'],
        [managed(), 'origin'],
      ],
    );
  });

  it("fetches each repository's base from GitHub into a git directory of the work root, from its clone's objects (ADR 0090)", async () => {
    const { calls, git } = fakeGit((_cwd, args) => {
      if (args.includes('refs/heads/main'))
        return { code: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '' };
      return undefined;
    });
    const shell = serveShell(setup, { root: 'brewery', git, out: () => {}, listen: () => {} });
    await shell.push(web()).baseTip('main');
    await shell.push(web({ source: 'managed' })).baseTip('main');
    assert.deepStrictEqual(objectsOf(calls), [clone, managed()]);
    assert.deepStrictEqual(reached(calls, 'fetch'), [
      [gitDirs(), gitDirs(), github],
      [gitDirs(), gitDirs(), github],
    ]);
  });

  it("fetches in each repository's clone, by its origin, before an attempt starts (ADR 0137)", async () => {
    mkdirSync(managed(), { recursive: true });
    const { calls, git } = fakeGit((_cwd, args) =>
      args.includes('main^{commit}')
        ? { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' }
        : undefined,
    );
    const shell = serveShell(setup, { root: 'brewery', git, out: () => {}, listen: () => {} });
    const attempt = { batchId: '12-1', stepId: 'plan', attempt: 1 };
    await (await shell.worktrees(web())).create(attempt, 'origin/main');
    await (await shell.worktrees(web({ source: 'managed' }))).create(attempt, 'origin/main');
    assert.deepStrictEqual(
      calls.filter((call) => call.includes('fetch')).map((call) => [call[0], call.at(-1)]),
      [
        [clone, 'origin'],
        [managed(), 'origin'],
      ],
    );
  });

  it('refuses a local repository without a clone instead of running git in the Brewery checkout (#202)', async () => {
    const { clone: _, ...cloneless } = web();
    const { calls, git } = fakeGit();
    const shell = serveShell(setup, { root: 'brewery', git, out: () => {}, listen: () => {} });
    const message = 'The local repository acme/web names no clone';
    assert.throws(() => shell.push(cloneless), { message });
    await assert.rejects(shell.worktrees(cloneless), { message });
    assert.deepStrictEqual(calls, []);
  });

  /** A git whose `clone` makes the folder it clones into, as git would. */
  const cloningGit = () =>
    fakeGit((_cwd, args) => {
      if (args[0] === 'clone') mkdirSync(args.at(-1) ?? '', { recursive: true });
      return undefined;
    });

  it("makes a managed repository's clone from GitHub, borrowing the user's clone's objects", async () => {
    const { calls, git } = cloningGit();
    const shell = serveShell(setup, { root: 'brewery', git, out: () => {}, listen: () => {} });
    const manager = await shell.worktrees(web({ source: 'managed' }));
    assert.equal(manager.root, join(workRoot, 'acme.web', 'attempts'));
    const cloned = calls.find(([, command]) => command === 'clone');
    assert.deepStrictEqual(cloned?.slice(1, -1), [
      'clone',
      '--bare',
      '--filter=blob:none',
      '--reference',
      clone,
      '--',
      'https://github.com/acme/web.git',
    ]);
    assert.equal(existsSync(join(workRoot, 'acme.web', 'clone.git')), true);
  });

  it("says on serve's output that the state branch removed a stale index.lock (ADR 0107)", async () => {
    const gitDir = join(workRoot, 'brewery-git', 'worktrees', 'state');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'index.lock'), '');
    const { git } = fakeGit((_cwd, args) => {
      const [command, first] = args;
      if (command === 'ls-remote') return { code: 2, stdout: '', stderr: '' };
      if (command === 'rev-parse' && first === '--absolute-git-dir') {
        return { code: 0, stdout: `${gitDir}\n`, stderr: '' };
      }
      if (command === 'rev-parse' && first === '--path-format=absolute') {
        return { code: 0, stdout: `${join(workRoot, 'brewery-git')}\n`, stderr: '' };
      }
      if (command === 'rev-parse' || command === 'config')
        return { code: 1, stdout: '', stderr: '' };
      if (command === 'write-tree' || command === 'commit-tree') {
        return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      }
      return undefined;
    });
    const said: string[] = [];
    const shell = serveShell(setup, {
      root: 'brewery',
      git,
      out: (line) => said.push(line),
      listen: () => {},
    });
    const store = openSqliteEventStore(':memory:');
    try {
      await shell.stateBranch(store).start();
    } finally {
      store.close();
    }
    assert.deepStrictEqual(said, [
      `foedrum serve: removed a stale index.lock from the state worktree: ${join(gitDir, 'index.lock')}`,
    ]);
  });

  it('keeps listening for stop signals while serve shuts down, and stops listening after', () => {
    const calls: string[] = [];
    const listening = listenWhileServing({
      on: (name) => calls.push(`on ${name}`),
      off: (name) => calls.push(`off ${name}`),
    });
    const handler = () => {};
    listening.listen('SIGINT', handler);
    listening.listen('SIGHUP', handler);
    listening.stop();
    assert.deepStrictEqual(calls, ['on SIGINT', 'on SIGHUP', 'off SIGINT', 'off SIGHUP']);
  });

  it('borrows nothing for a managed repository without a clone of the user', async () => {
    const { calls, git } = cloningGit();
    const shell = serveShell(setup, { root: 'brewery', git, out: () => {}, listen: () => {} });
    const { clone: _, ...managed } = web({ source: 'managed' });
    await shell.worktrees(managed);
    const cloned = calls.find(([, command]) => command === 'clone');
    assert.equal(cloned?.includes('--reference'), false);
  });
});
