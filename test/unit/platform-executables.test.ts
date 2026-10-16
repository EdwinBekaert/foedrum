import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { findNpmCli, resolveExecutable } from '../../src/platform/executables.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// A file system with only these runnable files.
const files =
  (...paths: string[]) =>
  (path: string): boolean =>
    paths.includes(path);

describe('resolveExecutable on Linux and macOS', () => {
  const resolve = (name: string, path: string | undefined, ...present: string[]) =>
    resolveExecutable(name, {
      platform: 'linux',
      env: path === undefined ? {} : { PATH: path },
      isExecutable: files(...present),
    });

  it('finds the command in the first PATH folder that has it', () => {
    assert.equal(
      resolve('git', '/usr/local/bin:/usr/bin:/bin', '/usr/bin/git', '/bin/git'),
      '/usr/bin/git',
    );
  });

  it('is undefined when no PATH folder has it', () => {
    assert.equal(resolve('git', '/usr/local/bin:/usr/bin'), undefined);
  });

  it('is undefined without a PATH', () => {
    assert.equal(resolve('git', undefined, '/usr/bin/git'), undefined);
  });

  // An empty entry means the current directory to a POSIX shell.
  it('skips empty PATH entries', () => {
    assert.equal(resolve('git', ':/usr/bin:', '/usr/bin/git', 'git'), '/usr/bin/git');
  });

  // A relative folder would be found against this directory but run against another one, such
  // as a worktree with a file of that name planted in it.
  it('skips PATH folders that are not absolute', () => {
    assert.equal(
      resolve(
        'git',
        'node_modules/.bin:.:/usr/bin',
        'node_modules/.bin/git',
        'git',
        '/usr/bin/git',
      ),
      '/usr/bin/git',
    );
  });

  it('does not add an extension', () => {
    assert.equal(resolve('claude', '/usr/bin', '/usr/bin/claude.cmd'), undefined);
  });

  it('checks a name with a folder in it directly, without PATH', () => {
    assert.equal(resolve('/opt/git/bin/git', '/usr/bin', '/opt/git/bin/git'), '/opt/git/bin/git');
    assert.equal(resolve('/opt/git/bin/git', '/usr/bin', '/usr/bin/git'), undefined);
  });
});

describe('resolveExecutable on Windows', () => {
  const resolve = (name: string, env: NodeJS.ProcessEnv, ...present: string[]) =>
    resolveExecutable(name, { platform: 'win32', env, isExecutable: files(...present) });

  it('tries each PATHEXT extension in order, folder by folder', () => {
    const env = { PATH: 'C:\\npm;C:\\Program Files\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(
      resolve('claude', env, 'C:\\npm\\claude.cmd', 'C:\\Program Files\\Git\\cmd\\claude.exe'),
      'C:\\npm\\claude.cmd',
    );
    assert.equal(
      resolve(
        'git',
        env,
        'C:\\Program Files\\Git\\cmd\\git.cmd',
        'C:\\Program Files\\Git\\cmd\\git.exe',
      ),
      'C:\\Program Files\\Git\\cmd\\git.exe',
    );
  });

  it('tries a name that already has a PATHEXT extension as it is', () => {
    const env = { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' };
    assert.equal(resolve('claude.CMD', env, 'C:\\npm\\claude.CMD'), 'C:\\npm\\claude.CMD');
    assert.equal(resolve('claude.cmd', env, 'C:\\npm\\claude.cmd.exe'), undefined);
  });

  it('reads Path and PATHEXT whatever their case', () => {
    assert.equal(
      resolve('git', { Path: 'C:\\Git\\cmd', PathExt: '.EXE' }, 'C:\\Git\\cmd\\git.exe'),
      'C:\\Git\\cmd\\git.exe',
    );
  });

  it('uses the default extensions when PATHEXT is not set', () => {
    assert.equal(
      resolve('claude', { PATH: 'C:\\npm' }, 'C:\\npm\\claude.cmd'),
      'C:\\npm\\claude.cmd',
    );
  });

  it('drops the quotes around a PATH folder and skips empty entries', () => {
    const env = { PATH: ';"C:\\Program Files\\Git\\cmd";', PATHEXT: '.EXE' };
    assert.equal(
      resolve('git', env, 'C:\\Program Files\\Git\\cmd\\git.exe'),
      'C:\\Program Files\\Git\\cmd\\git.exe',
    );
  });

  it('skips PATH folders that are not absolute', () => {
    const env = { PATH: 'node_modules\\.bin;.;C:\\Git\\cmd', PATHEXT: '.EXE' };
    assert.equal(
      resolve('git', env, 'node_modules\\.bin\\git.exe', 'git.exe', 'C:\\Git\\cmd\\git.exe'),
      'C:\\Git\\cmd\\git.exe',
    );
  });

  it('never looks in the current directory unless PATH names it', () => {
    assert.equal(resolve('git', { PATH: 'C:\\Git\\cmd', PATHEXT: '.EXE' }, 'git.exe'), undefined);
  });

  it('checks a name with a folder in it directly, with the PATHEXT extensions', () => {
    const env = { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' };
    assert.equal(
      resolve('D:\\tools\\claude', env, 'D:\\tools\\claude.cmd'),
      'D:\\tools\\claude.cmd',
    );
  });
});

// Each kind of PATH folder that is skipped, on its own: an empty one, a relative one and ".",
// all of which mean a folder relative to wherever the program starts.
describe('resolveExecutable and the PATH folders it skips', () => {
  for (const [platform, delimiter, bin, git] of [
    ['linux', ':', '/usr/bin', 'git'],
    ['win32', ';', 'C:\\Git\\cmd', 'git.exe'],
  ] as const) {
    const join = platform === 'win32' ? win32.join : posix.join;
    for (const [kind, folder] of [
      ['an empty', ''],
      ['a relative', platform === 'win32' ? 'node_modules\\.bin' : 'node_modules/.bin'],
      ['the "."', '.'],
    ] as const) {
      it(`skips ${kind} folder on ${platform}`, () => {
        const env = { PATH: `${folder}${delimiter}${bin}`, PATHEXT: '.EXE' };
        const planted = folder === '' ? git : join(folder, git);
        assert.equal(
          resolveExecutable('git', {
            platform,
            env,
            isExecutable: (path) => path === planted || path === join(bin, git),
          }),
          join(bin, git),
        );
      });
    }
  }
});

describe('resolveExecutable on this machine', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('executables');
  });
  afterEach(() => dir.remove());

  // The node running this test is a runnable file, found by its full path.
  it('finds this node by its path', () => {
    assert.equal(resolveExecutable(process.execPath), process.execPath);
  });

  it('skips a folder that has the name of the command', () => {
    mkdirSync(join(dir.path, 'tool'));
    mkdirSync(join(dir.path, 'tool.exe'));
    const env = { PATH: dir.path, PATHEXT: '.EXE' };
    assert.equal(resolveExecutable('tool', { env }), undefined);
  });

  it('skips a file that may not run', { skip: process.platform === 'win32' }, () => {
    writeFileSync(join(dir.path, 'tool'), '#!/bin/sh\n');
    chmodSync(join(dir.path, 'tool'), 0o644);
    assert.equal(resolveExecutable('tool', { env: { PATH: dir.path } }), undefined);
    chmodSync(join(dir.path, 'tool'), 0o755);
    assert.equal(resolveExecutable('tool', { env: { PATH: dir.path } }), join(dir.path, 'tool'));
  });
});

// The gate runs npm run check with npm's CLI script as installed with the node running it (#41).
describe('findNpmCli', () => {
  it('finds npm-cli.js in node_modules next to node.exe on Windows', () => {
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    assert.deepEqual(
      findNpmCli('C:\\Program Files\\nodejs\\node.exe', {
        platform: 'win32',
        isFile: files(npmCli),
      }),
      { path: npmCli, tried: [npmCli] },
    );
  });

  for (const platform of ['linux', 'darwin'] as const) {
    it(`finds npm-cli.js in lib/node_modules under node's prefix on ${platform}`, () => {
      const npmCli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
      assert.deepEqual(findNpmCli('/opt/node/bin/node', { platform, isFile: files(npmCli) }), {
        path: npmCli,
        tried: [npmCli],
      });
    });
  }

  it('finds nothing, naming the path it tried, when npm is not installed with node', () => {
    assert.deepEqual(findNpmCli('/usr/bin/node', { platform: 'linux', isFile: files() }), {
      path: undefined,
      tried: [posix.join('/usr', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')],
    });
  });

  // npm-cli.js where npm would be on another platform is not npm for this one.
  it('looks only where npm is on the given platform', () => {
    const elsewhere = '/opt/node/bin/node_modules/npm/bin/npm-cli.js';
    assert.equal(
      findNpmCli('/opt/node/bin/node', { platform: 'linux', isFile: files(elsewhere) }).path,
      undefined,
    );
  });

  it('finds a regular file named npm-cli.js where npm is installed with node', () => {
    const dir = makeTempDir('npm-cli');
    try {
      const bin = join(dir.path, 'bin');
      const npmCli =
        process.platform === 'win32'
          ? join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
          : join(dir.path, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      mkdirSync(join(npmCli, '..'), { recursive: true });
      writeFileSync(npmCli, '');
      assert.equal(findNpmCli(join(bin, 'node')).path, npmCli);
    } finally {
      dir.remove();
    }
  });

  it('skips a folder named npm-cli.js', () => {
    const dir = makeTempDir('npm-cli');
    try {
      const bin = join(dir.path, 'bin');
      mkdirSync(bin);
      const npmCli =
        process.platform === 'win32'
          ? join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
          : join(dir.path, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      mkdirSync(npmCli, { recursive: true });
      assert.equal(findNpmCli(join(bin, 'node')).path, undefined);
    } finally {
      dir.remove();
    }
  });
});
