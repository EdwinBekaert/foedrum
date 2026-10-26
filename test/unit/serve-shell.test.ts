// `foedrum serve` on the real machine (ADR 0063), with a fake git and fake signals: which signals
// stop it, and where each repository's attempt worktrees come from (a local clone, or a managed
// clone made from GitHub that borrows the local clone's objects). No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import { type ServeRepository, type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../../src/cli/serve-shell.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
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

  // The clone's objects reach a merged tree's check only from Foedrum's own git directories, never
  // from an attempt's worktree (ADR 0203, review of #528).
  it("binds a repository's borrowed stores only from its own git directories", async () => {
    const { git } = fakeGit();
    const store = '/home/brewer/clones/acme.web/.git/objects';
    const started: string[][] = [];
    const shellWith = (repository: string) =>
      serveShell(setup, {
        root: 'brewery',
        git,
        out: () => {},
        listen: () => {},
        checks: {
          exec: async (file: string, args: readonly string[]) => {
            started.push([file, ...args]);
            return { exitCode: 0, stdout: '', stderr: '', output: '' };
          },
          platform: 'linux' as const,
          findBwrap: () => '/usr/bin/bwrap',
          // The setup's user-mode network stack (ADR 0218), never looked up on this machine.
          findStackTool: (name: string) => (name === 'pasta' ? '/usr/bin/pasta' : undefined),
          realPath: (path: string) => path,
          gitDirOf: () => repository,
          borrowedOf: () => [store],
          home: '/home/brewer',
        },
      });
    const gitDirs = join(workRoot, 'acme.web', 'git-dirs');
    mkdirSync(gitDirs, { recursive: true });
    const own = join(gitDirs, '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d.git');
    mkdirSync(own);
    await shellWith(own).exec('npm test', [], { cwd: workRoot, shell: true });
    await shellWith(own).setup('npm ci', [], { cwd: workRoot, shell: true });
    const attempt = join(workRoot, 'acme.web', 'attempts', '12-1', 'build', '1', 'x');
    mkdirSync(attempt, { recursive: true });
    await shellWith(attempt).exec('npm test', [], { cwd: workRoot, shell: true });
    assert.deepStrictEqual(
      started.map((args) => args.includes(store)),
      [true, true, false],
    );
  });

  it("starts a repository's setup in the OS sandbox with the network kept, never as it is (ADR 0158)", async () => {
    const { git } = fakeGit();
    const started: string[][] = [];
    const checks = {
      exec: async (file: string, args: readonly string[]) => {
        started.push([file, ...args]);
        return { exitCode: 0, stdout: '', stderr: '', output: '' };
      },
      platform: 'linux' as const,
      findBwrap: () => '/usr/bin/bwrap',
      findStackTool: (name: string) => (name === 'pasta' ? '/usr/bin/pasta' : undefined),
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
    await shell.setup('npm ci', [], { cwd: '/work/wt', shell: true });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.[0], '/usr/bin/bwrap');
    assert.ok(started[0]?.includes('/home/brewer'));
    // A network namespace of its own, which a user-mode network stack joins (ADR 0218).
    assert.ok(started[0]?.includes('--unshare-net'));
    assert.deepStrictEqual(started[0]?.slice(-3), ['/bin/sh', '-c', 'npm ci']);
  });

  // ADR 0163: a fresh brewer attempt's setup goes through the same sandbox, before claude starts.
  it("runs a brewer attempt's setup in the OS sandbox with the network kept, before claude", async () => {
    const { git } = fakeGit();
    const started: string[][] = [];
    const checks = {
      exec: async (file: string, args: readonly string[]) => {
        started.push([file, ...args]);
        // A setup that fails, so the runner never starts claude.
        return { exitCode: 1, stdout: '', stderr: '', output: 'npm ERR!' };
      },
      platform: 'linux' as const,
      findBwrap: () => '/usr/bin/bwrap',
      findStackTool: (name: string) => (name === 'pasta' ? '/usr/bin/pasta' : undefined),
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
    const assembled = assembleBrewerPrompt('Plan the change.', []);
    if (assembled.kind !== 'assembled') throw new Error('the test prompt was refused');
    const settingsFile = join(workRoot, 'attempt-settings', 'plan.json');
    mkdirSync(dirname(settingsFile), { recursive: true });
    const runner = shell.runner('/opt/claude/bin/claude', async () => ({
      cwd: '/work/wt',
      env: { PATH: '/usr/bin' },
      prompt: assembled.prompt,
      call: {
        model: 'claude-haiku-5-5',
        effort: 'low',
        tools: ['Read'],
        session: { kind: 'new', id: '00000000-0000-4000-8000-000000000001' },
      },
      permissions: { allow: ['Read'], deny: [], sandbox: false },
      settingsFile,
      setup: {
        run: { command: 'npm ci', timeoutMs: 600_000, unsandboxed: false },
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        env: { PATH: '/usr/bin' },
      },
    }));
    const limits = { outDoc: { file: 'plan.md', schema: OutDocFrontmatter } };
    const end = await runner.start({ ref: { batchId: '1-1', stepId: 'plan', attempt: 1 }, limits })
      .ended;
    assert.equal(started.length, 1);
    assert.equal(started[0]?.[0], '/usr/bin/bwrap');
    // A network namespace of its own, which a user-mode network stack joins (ADR 0218).
    assert.ok(started[0]?.includes('--unshare-net'));
    assert.deepStrictEqual(started[0]?.slice(-3), ['/bin/sh', '-c', 'npm ci']);
    assert.deepStrictEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the setup "npm ci" failed with exit code 1',
    });
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

  describe('keeping the machine awake while an attempt runs (ADR 0195)', () => {
    const caffeinate = { kind: 'caffeinate', program: '/usr/bin/caffeinate' } as const;
    const recording = () => {
      const started: string[] = [];
      const exec: ExecProcess = (file, args) => {
        started.push([file, ...args].join(' '));
        return new Promise(() => {});
      };
      return { started, exec };
    };

    it("holds the machine awake through this machine's mechanism, watching Foedrum's process", () => {
      const { started, exec } = recording();
      const shell = serveShell(setup, {
        root: 'brewery',
        git: fakeGit().git,
        out: () => {},
        listen: () => {},
        keepAwake: { mechanism: caffeinate, pid: 4242, exec },
      });
      (shell.awake ?? assert.fail('the shell has no hold')).attemptStarted();
      assert.deepStrictEqual(started, ['/usr/bin/caffeinate -i -w 4242']);
    });

    it('starts nothing when the Brewery or this machine says keepAwake: false', () => {
      const { started, exec } = recording();
      const off = serveSetup(
        serveInputs({
          files: { ...serveInputs().files, local: local({ workRoot, keepAwake: false }) },
        }),
      );
      const shell = serveShell(off.kind === 'ready' ? off.setup : assert.fail(), {
        root: 'brewery',
        git: fakeGit().git,
        out: () => {},
        listen: () => {},
        keepAwake: { mechanism: caffeinate, pid: 4242, exec },
      });
      (shell.awake ?? assert.fail('the shell has no hold')).attemptStarted();
      assert.deepStrictEqual(started, []);
    });

    it('starts nothing on a machine with no mechanism', () => {
      const { started, exec } = recording();
      const shell = serveShell(setup, {
        root: 'brewery',
        git: fakeGit().git,
        out: () => {},
        listen: () => {},
        keepAwake: { mechanism: { kind: 'none', why: 'no caffeinate on PATH' }, pid: 4242, exec },
      });
      (shell.awake ?? assert.fail('the shell has no hold')).attemptStarted();
      assert.deepStrictEqual(started, []);
    });
  });
});
