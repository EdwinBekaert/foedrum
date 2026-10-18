// `foedrum serve` on the real machine (ADR 0063), with a fake git and fake signals: which signals
// stop it, and where each repository's attempt worktrees come from (a local clone, or a managed
// clone made from GitHub that borrows the local clone's objects). No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type ServeRepository, type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../../src/cli/serve-shell.ts';
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

  it("pushes from the user's clone of a local repository, and from the managed clone (ADR 0071)", async () => {
    const tip = 'c'.repeat(40);
    const branch = 'foedrum/acme.brewery/12-1/acme.web';
    const { calls, git } = fakeGit();
    const shell = serveShell(setup, { root: 'brewery', git, out: () => {}, listen: () => {} });
    await shell.push(web()).push(tip, branch);
    await shell.push(web({ source: 'managed' })).push(tip, branch);
    assert.deepStrictEqual(
      calls.map(([cwd, command]) => `${cwd} ${command}`),
      [`${clone} push`, `${join(workRoot, 'acme.web', 'clone.git')} push`],
    );
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
