import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveExecutable } from '../../src/platform/executables.ts';

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

describe('resolveExecutable on this machine', () => {
  // The node running this test is a runnable file, found by its full path.
  it('finds this node by its path', () => {
    assert.equal(resolveExecutable(process.execPath), process.execPath);
  });
});
