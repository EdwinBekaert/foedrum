// The lockfile a release bump leaves behind (ADR 0412): which lockfiles the changed paths of an
// attempt's commits name, how each refresh runs in a scratch tree through the setup's process
// runner, and how one that does not pass settles the attempt (a fake process runner, ADR 0021).

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { settleReadings } from '../../src/checks/gravity.ts';
import {
  CARGO_REFRESH,
  lockfileRefreshes,
  NPM_REFRESH,
  NUGET_REFRESH,
  type RefreshRun,
  refreshLockfiles,
} from '../../src/checks/lockfile.ts';
import type { ExecOptions, ExecResult } from '../../src/platform/processes.ts';
import { suiteFolders } from '../helpers/attempt-worktrees.ts';

const nextFolder = suiteFolders('lockfile');

describe('lockfileRefreshes', () => {
  it('names the package-lock.json beside each changed package.json, at the root and in a folder', () => {
    assert.deepStrictEqual(
      lockfileRefreshes(['src/a.ts', 'package.json', 'packages/web/package.json']),
      [
        { folder: '', lockfile: 'package-lock.json', command: NPM_REFRESH },
        {
          folder: 'packages/web',
          lockfile: 'packages/web/package-lock.json',
          command: NPM_REFRESH,
        },
      ],
    );
  });

  it('names nothing for a package.json whose path holds a paragraph separator', () => {
    assert.deepStrictEqual(
      lockfileRefreshes([`a${String.fromCodePoint(0x2029)}b/package.json`, 'web/package.json']),
      [{ folder: 'web', lockfile: 'web/package-lock.json', command: NPM_REFRESH }],
    );
  });

  it('names nothing for a package.json under node_modules, nor for a changed lockfile alone', () => {
    assert.deepStrictEqual(
      lockfileRefreshes([
        'node_modules/greet/package.json',
        'package-lock.json',
        'my-package.json',
      ]),
      [],
    );
  });

  it('names nothing for a package.json whose path holds a line break or a control character', () => {
    assert.deepStrictEqual(
      lockfileRefreshes([
        'a\nb/package.json',
        `a${String.fromCodePoint(0x2028)}b/package.json`,
        'a\u0007b/package.json',
        'web/package.json',
      ]),
      [{ folder: 'web', lockfile: 'web/package-lock.json', command: NPM_REFRESH }],
    );
  });
});

/** A process runner that records each run and answers with `answer`, after `effect` in its folder. */
const fakeExec = (answer: Partial<ExecResult> = {}, effect: (cwd: string) => void = () => {}) => {
  const runs: { command: string; options: ExecOptions | undefined }[] = [];
  const exec = async (command: string, _args: readonly string[], options?: ExecOptions) => {
    runs.push({ command, options });
    effect(options?.cwd ?? '');
    const result: ExecResult = { exitCode: 0, stdout: '', stderr: '', output: '', ...answer };
    return result;
  };
  return { exec, runs };
};

const runOf = (exec: RefreshRun['exec'], unsandboxed = false): RefreshRun => ({
  exec,
  env: { PATH: '/usr/bin', npm_config_ignore_scripts: 'true' },
  deadlineAt: '2026-11-17T13:00:00.000Z',
  now: () => new Date('2026-11-17T12:00:00.000Z'),
  signal: new AbortController().signal,
  unsandboxed,
});

/** A scratch tree with `files`, each relative with forward slashes. */
const treeWith = (files: Record<string, string>): string => {
  const tree = nextFolder();
  for (const [file, text] of Object.entries(files)) {
    const path = join(tree, ...file.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return tree;
};

const web = { folder: 'web', lockfile: 'web/package-lock.json', command: NPM_REFRESH };

describe('refreshLockfiles', () => {
  it("runs the refresh in its lockfile's folder through the setup's runner, and lists the lockfile it changed", async () => {
    const tree = treeWith({ 'web/package.json': '{}', 'web/package-lock.json': 'v1.1.0\n' });
    const { exec, runs } = fakeExec({}, (cwd) => {
      writeFileSync(join(cwd, 'package-lock.json'), 'v1.2.0\n');
    });
    const refreshed = await refreshLockfiles(tree, [web], runOf(exec));
    assert.deepStrictEqual(refreshed, {
      readings: [
        {
          result: 'exited',
          lockfile: 'web/package-lock.json',
          command: NPM_REFRESH,
          exitCode: 0,
          tail: '',
        },
      ],
      files: ['web/package-lock.json'],
    });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.command, NPM_REFRESH);
    assert.equal(runs[0]?.options?.cwd, join(tree, 'web'));
    assert.equal(runs[0]?.options?.shell, true);
    assert.equal(runs[0]?.options?.env?.npm_config_ignore_scripts, 'true');
    assert.equal(readFileSync(join(tree, 'web', 'package-lock.json'), 'utf8'), 'v1.2.0\n');
  });

  it('lists no lockfile that the refresh left as it was', async () => {
    const tree = treeWith({ 'web/package.json': '{}', 'web/package-lock.json': 'v1.2.0\n' });
    const { exec, runs } = fakeExec();
    const refreshed = await refreshLockfiles(tree, [web], runOf(exec));
    assert.equal(runs.length, 1);
    assert.deepStrictEqual(refreshed.files, []);
  });

  it('runs nothing where the tree holds no lockfile beside the manifest', async () => {
    const tree = treeWith({ 'web/package.json': '{}' });
    const { exec, runs } = fakeExec();
    assert.deepStrictEqual(await refreshLockfiles(tree, [web], runOf(exec)), {
      readings: [],
      files: [],
    });
    assert.deepStrictEqual(runs, []);
  });

  it('runs nothing for a lockfile that is no regular file, such as a link out of the tree', async () => {
    const outside = treeWith({ 'package-lock.json': 'outside\n' });
    const tree = treeWith({ 'web/package.json': '{}' });
    // A junction, which Windows makes without a privilege.
    symlinkSync(outside, join(tree, 'web', 'package-lock.json'), 'junction');
    const { exec, runs } = fakeExec();
    assert.deepStrictEqual(await refreshLockfiles(tree, [web], runOf(exec)), {
      readings: [],
      files: [],
    });
    assert.deepStrictEqual(runs, []);
  });

  it('runs nothing for a lockfile in a folder that links out of the tree, though it is a regular file there', async () => {
    const outside = treeWith({ 'package.json': '{}', 'package-lock.json': 'outside\n' });
    const tree = nextFolder();
    // The commit's folder web is a junction to a folder outside the tree.
    symlinkSync(outside, join(tree, 'web'), 'junction');
    const { exec, runs } = fakeExec();
    assert.deepStrictEqual(await refreshLockfiles(tree, [web], runOf(exec)), {
      readings: [],
      files: [],
    });
    assert.deepStrictEqual(runs, []);
  });

  it("kills a refresh after 5 minutes, or 10 seconds before the attempt's deadline when that is sooner", async () => {
    const tree = treeWith({ 'web/package.json': '{}', 'web/package-lock.json': 'v1.1.0\n' });
    const { exec, runs } = fakeExec();
    await refreshLockfiles(tree, [web], runOf(exec));
    // Two minutes before the deadline.
    await refreshLockfiles(tree, [web], {
      ...runOf(exec),
      now: () => new Date('2026-11-17T12:58:00.000Z'),
    });
    assert.deepStrictEqual(
      runs.map(({ options }) => options?.timeoutMs),
      [300_000, 110_000],
    );
  });

  it('stops at the first refresh that does not pass, its reading naming the lockfile', async () => {
    const tree = treeWith({
      'package.json': '{}',
      'package-lock.json': 'v1.1.0\n',
      'web/package.json': '{}',
      'web/package-lock.json': 'v1.1.0\n',
    });
    const root = { folder: '', lockfile: 'package-lock.json', command: NPM_REFRESH };
    const { exec, runs } = fakeExec({ exitCode: 1, output: 'npm ERR! 404 greet@v1.2.0' });
    const refreshed = await refreshLockfiles(tree, [root, web], runOf(exec, true));
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.options?.cwd, tree);
    assert.deepStrictEqual(refreshed, {
      readings: [
        {
          result: 'exited',
          lockfile: 'package-lock.json',
          command: NPM_REFRESH,
          unsandboxed: true,
          exitCode: 1,
          tail: 'npm ERR! 404 greet@v1.2.0',
        },
      ],
      files: [],
    });
  });
});

describe('refreshLockfiles: a refresh that does not pass after one that did', () => {
  it('lists no lockfile to commit, not even the one an earlier refresh changed', async () => {
    const tree = treeWith({
      'package.json': '{}',
      'package-lock.json': 'v1.1.0\n',
      'web/package.json': '{}',
      'web/package-lock.json': 'v1.1.0\n',
    });
    const root = { folder: '', lockfile: 'package-lock.json', command: NPM_REFRESH };
    // The root's refresh changes its lockfile; web's fails.
    const exec = async (_command: string, _args: readonly string[], options?: ExecOptions) => {
      const failing = options?.cwd === join(tree, 'web');
      if (!failing) writeFileSync(join(options?.cwd ?? '', 'package-lock.json'), 'v1.2.0\n');
      const result: ExecResult = {
        exitCode: failing ? 1 : 0,
        stdout: '',
        stderr: '',
        output: failing ? 'npm ERR! 404' : '',
      };
      return result;
    };
    const refreshed = await refreshLockfiles(tree, [root, web], runOf(exec));
    assert.deepStrictEqual(
      refreshed.readings.map(({ result }) => result),
      ['exited', 'exited'],
    );
    assert.deepStrictEqual(refreshed.files, []);
  });
});

describe('settleReadings: a lockfile refresh (ADR 0412)', () => {
  it('a refresh that fails blocks the attempt on its environment, naming the lockfile', () => {
    assert.deepStrictEqual(
      settleReadings([
        {
          result: 'exited',
          lockfile: 'web/package-lock.json',
          command: NPM_REFRESH,
          exitCode: 1,
          tail: 'npm ERR!',
        },
      ]),
      {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: `the lockfile web/package-lock.json could not be refreshed: "${NPM_REFRESH}" failed with exit code 1`,
      },
    );
  });

  it('a refresh that cannot start blocks the attempt on its environment, naming the lockfile and why', () => {
    assert.deepStrictEqual(
      settleReadings([
        {
          result: 'unstarted',
          lockfile: 'package-lock.json',
          command: NPM_REFRESH,
          tail: 'no bwrap',
        },
      ]),
      {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: `the lockfile package-lock.json could not be refreshed: "${NPM_REFRESH}" could not start: no bwrap`,
      },
    );
  });

  it('a refresh stopped with the engine cancels the attempt (regression test)', () => {
    assert.deepStrictEqual(
      settleReadings([
        {
          result: 'killed',
          lockfile: 'package-lock.json',
          command: NPM_REFRESH,
          killed: 'stopped',
          tail: '',
        },
      ]),
      { kind: 'cancelled' },
    );
  });
});

describe('lockfileRefreshes: Cargo and NuGet (ADR 0415)', () => {
  it("looks for a changed Cargo.toml's Cargo.lock from its folder up, with cargo update --workspace", () => {
    assert.deepStrictEqual(lockfileRefreshes(['Cargo.toml', 'crates/a/Cargo.toml', 'src/a.rs']), [
      { folder: '', lockfile: 'Cargo.lock', command: CARGO_REFRESH, find: 'above' },
      {
        folder: 'crates/a',
        lockfile: 'crates/a/Cargo.lock',
        command: CARGO_REFRESH,
        find: 'above',
      },
    ]);
  });

  it('names nothing for a Cargo.toml in a vendor or a target folder', () => {
    assert.deepStrictEqual(
      lockfileRefreshes(['vendor/x/Cargo.toml', 'target/x/Cargo.toml', 'b/Cargo.toml']),
      [{ folder: 'b', lockfile: 'b/Cargo.lock', command: CARGO_REFRESH, find: 'above' }],
    );
  });

  it('names the packages.lock.json beside each changed .NET project, restoring that project by name', () => {
    assert.deepStrictEqual(
      lockfileRefreshes(['src/Web/Web.csproj', 'Lib.fsproj', 'tools/Old.vbproj', 'App.sln']),
      [
        {
          folder: 'src/Web',
          lockfile: 'src/Web/packages.lock.json',
          command: `${NUGET_REFRESH} "Web.csproj"`,
        },
        { folder: '', lockfile: 'packages.lock.json', command: `${NUGET_REFRESH} "Lib.fsproj"` },
        {
          folder: 'tools',
          lockfile: 'tools/packages.lock.json',
          command: `${NUGET_REFRESH} "Old.vbproj"`,
        },
      ],
    );
  });

  it('names nothing for a .NET project in a bin or an obj folder', () => {
    assert.deepStrictEqual(
      lockfileRefreshes(['bin/Web.csproj', 'Web/obj/Web.csproj', 'Api/Api.csproj']),
      [
        {
          folder: 'Api',
          lockfile: 'Api/packages.lock.json',
          command: `${NUGET_REFRESH} "Api.csproj"`,
        },
      ],
    );
  });

  it('names nothing for a .NET project whose name a shell line cannot quote', () => {
    assert.deepStrictEqual(
      lockfileRefreshes(['web/$(x).csproj', 'web/-Web.csproj', 'api/Api.csproj']),
      [
        {
          folder: 'api',
          lockfile: 'api/packages.lock.json',
          command: `${NUGET_REFRESH} "Api.csproj"`,
        },
      ],
    );
  });

  it('looks for the packages.lock.json of each project below a changed Directory.Packages.props', () => {
    assert.deepStrictEqual(
      lockfileRefreshes(['Directory.Packages.props', 'src/Directory.Packages.props']),
      [
        { folder: '', lockfile: 'packages.lock.json', command: NUGET_REFRESH, find: 'below' },
        {
          folder: 'src',
          lockfile: 'src/packages.lock.json',
          command: NUGET_REFRESH,
          find: 'below',
        },
      ],
    );
  });
});

const member = {
  folder: 'crates/a',
  lockfile: 'crates/a/Cargo.lock',
  command: CARGO_REFRESH,
  find: 'above' as const,
};

/** A process runner that writes `text` over `file` in its folder, and records each run. */
const writing = (file: string, text = 'v1.2.0\n') =>
  fakeExec({}, (cwd) => {
    writeFileSync(join(cwd, file), text);
  });

describe('refreshLockfiles: a lockfile found above its manifest (ADR 0415)', () => {
  it("refreshes the workspace's Cargo.lock above a member, in the lockfile's folder", async () => {
    const tree = treeWith({
      'Cargo.toml': '[workspace]\n',
      'Cargo.lock': 'v1.1.0\n',
      'crates/a/Cargo.toml': '[package]\n',
    });
    const { exec, runs } = writing('Cargo.lock');
    const refreshed = await refreshLockfiles(tree, [member], runOf(exec));
    assert.deepStrictEqual(
      runs.map(({ command, options }) => [command, options?.cwd]),
      [[CARGO_REFRESH, tree]],
    );
    assert.deepStrictEqual(refreshed.files, ['Cargo.lock']);
    assert.deepStrictEqual(
      refreshed.readings.map((reading) => ('lockfile' in reading ? reading.lockfile : undefined)),
      ['Cargo.lock'],
    );
  });

  it('refreshes the nearest Cargo.lock above, not one further up', async () => {
    const tree = treeWith({
      'Cargo.lock': 'root\n',
      'crates/Cargo.lock': 'v1.1.0\n',
      'crates/a/Cargo.toml': '[package]\n',
    });
    const { exec, runs } = writing('Cargo.lock');
    const refreshed = await refreshLockfiles(tree, [member], runOf(exec));
    assert.deepStrictEqual(
      runs.map(({ options }) => options?.cwd),
      [join(tree, 'crates')],
    );
    assert.deepStrictEqual(refreshed.files, ['crates/Cargo.lock']);
    assert.equal(readFileSync(join(tree, 'Cargo.lock'), 'utf8'), 'root\n');
  });

  it('runs nothing when no folder from the manifest up to the root holds a Cargo.lock', async () => {
    const tree = treeWith({ 'crates/a/Cargo.toml': '[package]\n' });
    const { exec, runs } = writing('Cargo.lock');
    assert.deepStrictEqual(await refreshLockfiles(tree, [member], runOf(exec)), {
      readings: [],
      files: [],
    });
    assert.deepStrictEqual(runs, []);
  });

  it('refreshes a Cargo.lock two changed members share once', async () => {
    const tree = treeWith({
      'Cargo.lock': 'v1.1.0\n',
      'crates/a/Cargo.toml': '[package]\n',
      'crates/b/Cargo.toml': '[package]\n',
    });
    const other = { ...member, folder: 'crates/b', lockfile: 'crates/b/Cargo.lock' };
    const { exec, runs } = writing('Cargo.lock');
    const refreshed = await refreshLockfiles(tree, [member, other], runOf(exec));
    assert.equal(runs.length, 1);
    assert.deepStrictEqual(refreshed.files, ['Cargo.lock']);
  });
});

const props = {
  folder: 'src',
  lockfile: 'src/packages.lock.json',
  command: NUGET_REFRESH,
  find: 'below' as const,
};

describe('refreshLockfiles: the lockfiles of the projects below a Directory.Packages.props (ADR 0415)', () => {
  it('restores each project beside a packages.lock.json below it, by name, and lists the lockfiles it changed', async () => {
    const tree = treeWith({
      'src/Directory.Packages.props': '<Project />',
      // Made before Api, so only the walk's own order puts Api first.
      'src/Web/Web.csproj': '<Project />',
      'src/Web/packages.lock.json': 'v1.1.0\n',
      'src/Api/Api.csproj': '<Project />',
      'src/Api/packages.lock.json': 'v1.1.0\n',
      'src/Root.csproj': '<Project />',
      'src/packages.lock.json': 'v1.1.0\n',
      'src/Docs/Docs.csproj': '<Project />',
      'Other/Other.csproj': '<Project />',
      'Other/packages.lock.json': 'v1.1.0\n',
    });
    const { exec, runs } = writing('packages.lock.json');
    const refreshed = await refreshLockfiles(tree, [props], runOf(exec));
    assert.deepStrictEqual(
      runs.map(({ command, options }) => [command, options?.cwd]),
      [
        [`${NUGET_REFRESH} "Root.csproj"`, join(tree, 'src')],
        [`${NUGET_REFRESH} "Api.csproj"`, join(tree, 'src', 'Api')],
        [`${NUGET_REFRESH} "Web.csproj"`, join(tree, 'src', 'Web')],
      ],
    );
    assert.deepStrictEqual(refreshed.files, [
      'src/packages.lock.json',
      'src/Api/packages.lock.json',
      'src/Web/packages.lock.json',
    ]);
  });

  it('passes over the bin, obj, node_modules and .git folders below it', async () => {
    const tree = treeWith({
      'src/bin/A/A.csproj': '<Project />',
      'src/bin/A/packages.lock.json': 'v1.1.0\n',
      'src/obj/B/B.csproj': '<Project />',
      'src/obj/B/packages.lock.json': 'v1.1.0\n',
      'src/node_modules/C/C.csproj': '<Project />',
      'src/node_modules/C/packages.lock.json': 'v1.1.0\n',
      'src/.git/D/D.csproj': '<Project />',
      'src/.git/D/packages.lock.json': 'v1.1.0\n',
      'src/E/E.csproj': '<Project />',
      'src/E/packages.lock.json': 'v1.1.0\n',
    });
    const { exec, runs } = writing('packages.lock.json');
    await refreshLockfiles(tree, [props], runOf(exec));
    assert.deepStrictEqual(
      runs.map(({ command }) => command),
      [`${NUGET_REFRESH} "E.csproj"`],
    );
  });

  it('restores no folder with two projects or none beside its packages.lock.json, nor a project it cannot quote', async () => {
    const tree = treeWith({
      'src/Two/A.csproj': '<Project />',
      'src/Two/B.fsproj': '<Project />',
      'src/Two/packages.lock.json': 'v1.1.0\n',
      'src/None/packages.lock.json': 'v1.1.0\n',
      'src/Odd/-Odd.csproj': '<Project />',
      'src/Odd/packages.lock.json': 'v1.1.0\n',
      'src/One/One.vbproj': '<Project />',
      'src/One/packages.lock.json': 'v1.1.0\n',
    });
    const { exec, runs } = writing('packages.lock.json');
    await refreshLockfiles(tree, [props], runOf(exec));
    assert.deepStrictEqual(
      runs.map(({ command }) => command),
      [`${NUGET_REFRESH} "One.vbproj"`],
    );
  });

  it('passes over a Bin folder in any case, as a file system that ignores case holds it', async () => {
    const tree = treeWith({
      'src/Bin/F/F.csproj': '<Project />',
      'src/Bin/F/packages.lock.json': 'v1.1.0\n',
      'src/E/E.csproj': '<Project />',
      'src/E/packages.lock.json': 'v1.1.0\n',
    });
    const { exec, runs } = writing('packages.lock.json');
    await refreshLockfiles(tree, [props], runOf(exec));
    assert.deepStrictEqual(
      runs.map(({ command }) => command),
      [`${NUGET_REFRESH} "E.csproj"`],
    );
  });

  it('restores no project in a folder whose path holds a line separator', async () => {
    const tree = treeWith({
      [`src/a${String.fromCodePoint(0x2028)}b/One.csproj`]: '<Project />',
      [`src/a${String.fromCodePoint(0x2028)}b/packages.lock.json`]: 'v1.1.0\n',
      'src/Two/Two.csproj': '<Project />',
      'src/Two/packages.lock.json': 'v1.1.0\n',
    });
    const { exec, runs } = writing('packages.lock.json');
    await refreshLockfiles(tree, [props], runOf(exec));
    assert.deepStrictEqual(
      runs.map(({ command }) => command),
      [`${NUGET_REFRESH} "Two.csproj"`],
    );
  });

  it('fails on a folder below it that cannot be read, rather than refresh nothing there', async () => {
    // The props's folder is a file in this tree, so reading it fails.
    const tree = treeWith({ src: 'not a folder\n' });
    const { exec, runs } = writing('packages.lock.json');
    await assert.rejects(refreshLockfiles(tree, [props], runOf(exec)), { code: 'ENOTDIR' });
    assert.deepStrictEqual(runs, []);
  });

  it('runs nothing below a folder that links out of the tree', async () => {
    const outside = treeWith({
      'Web/Web.csproj': '<Project />',
      'Web/packages.lock.json': 'v1.1.0\n',
    });
    const tree = treeWith({ 'Api/Api.csproj': '<Project />', 'Api/packages.lock.json': 'v\n' });
    // A junction from inside the tree to a folder outside it.
    symlinkSync(join(outside, 'Web'), join(tree, 'Web'), 'junction');
    const { exec, runs } = writing('packages.lock.json');
    await refreshLockfiles(
      tree,
      [{ ...props, folder: '', lockfile: 'packages.lock.json' }],
      runOf(exec),
    );
    assert.deepStrictEqual(
      runs.map(({ command }) => command),
      [`${NUGET_REFRESH} "Api.csproj"`],
    );
  });
});
