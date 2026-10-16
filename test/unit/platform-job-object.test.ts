// The Job Object helper's command (#92, ADR 0039) as plain data: how a command becomes the
// command line CreateProcess gets, and how PowerShell is started with it. The helper itself runs
// in test/integration/processes.test.ts.

import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { describe, it } from 'node:test';
import {
  jobObjectCommand,
  jobObjectLine,
  windowsArgument,
  windowsEnvironmentBlock,
} from '../../src/platform/job-object.ts';
import { spawnCommand } from '../../src/platform/processes.ts';

describe('windowsArgument', () => {
  // The quoting node's spawn uses (libuv), read back by CommandLineToArgvW and the C runtime.
  const cases: [string, string][] = [
    ['status', 'status'],
    ['', '""'],
    ['a b', '"a b"'],
    ['a\tb', '"a\tb"'],
    ['C:\\Program Files\\Git\\cmd\\git.exe', '"C:\\Program Files\\Git\\cmd\\git.exe"'],
    ['C:\\Git\\git.exe', 'C:\\Git\\git.exe'],
    ['c"d', '"c\\"d"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['dir with\\', '"dir with\\\\"'],
    ['dir with\\\\', '"dir with\\\\\\\\"'],
    ['a\\b c', '"a\\b c"'],
  ];
  for (const [argument, quoted] of cases) {
    it(`quotes ${JSON.stringify(argument)} as ${quoted}`, () => {
      assert.equal(windowsArgument(argument), quoted);
    });
  }
});

describe('jobObjectLine', () => {
  const env = { SystemRoot: 'C:\\Windows' };

  it('starts a program by its path, with every part quoted as node would', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    assert.deepEqual(jobObjectLine(spawnCommand(node, ['-e', 'x()', 'a b', ''], 'win32', env)), {
      application: node,
      line: '"C:\\Program Files\\nodejs\\node.exe" -e x() "a b" ""',
    });
  });

  // As node starts a shell command: cmd.exe /d /s /c "<line>", the line checked by
  // windowsCommandLine (ADR 0031).
  it('starts a .cmd file through cmd.exe by its full path', () => {
    const npm = 'C:\\Program Files\\nodejs\\npm.cmd';
    assert.deepEqual(jobObjectLine(spawnCommand(npm, ['--version'], 'win32', env)), {
      application: 'C:\\Windows\\System32\\cmd.exe',
      line: 'C:\\Windows\\System32\\cmd.exe /d /s /c ""C:\\Program Files\\nodejs\\npm.cmd" "--version""',
    });
  });
});

describe('jobObjectCommand', () => {
  const env = { PATH: 'C:\\nodejs', SystemRoot: 'D:\\WINDOWS' };
  const git = spawnCommand('C:\\Git\\cmd\\git.exe', ['status'], 'win32', env);
  const script = (args: readonly string[]): string =>
    Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
  const decoded = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

  // Windows PowerShell by its full path, never through PATH or the working directory, as
  // cmd.exe and taskkill are.
  it('starts Windows PowerShell by its full path, without a shell', () => {
    const helper = jobObjectCommand(git, 'D:\\work\\tree');
    assert.equal(helper.file, 'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(helper.shell, false);
  });

  it('finds PowerShell in C:\\Windows when SystemRoot is not set, and reads it in any case', () => {
    const bare = spawnCommand('C:\\Git\\cmd\\git.exe', [], 'win32', {
      PATH: 'C:\\nodejs',
    });
    assert.equal(
      jobObjectCommand(bare, 'D:\\work').file,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    const upper = spawnCommand('C:\\Git\\cmd\\git.exe', [], 'win32', {
      SYSTEMROOT: 'E:\\Win',
    });
    assert.equal(jobObjectCommand(upper, 'D:\\work').cwd, 'E:\\Win\\System32');
  });

  // No profile, no prompt, and the script as an encoded command, which no execution policy
  // blocks and no quoting can break.
  it('runs the helper script without a profile or a prompt, as an encoded command', () => {
    const { args } = jobObjectCommand(git, 'D:\\work\\tree');
    assert.deepEqual(args.slice(0, -1), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    assert.match(script(args), /CreateProcessW/);
  });

  // The program gets the caller's environment as a block of its own (CREATE_UNICODE_ENVIRONMENT),
  // which reaches the helper in a variable of the helper's environment: on the command line it
  // would take about 3.6 characters of the 32,767 for each of its own (ADR 0039).
  it("gives the helper the command's environment as a block, beside its own", () => {
    const helper = jobObjectCommand(git, 'D:\\work\\tree');
    const { FOEDRUM_JOB_ENVIRONMENT: block, ...rest } = helper.env;
    assert.deepEqual(rest, git.env);
    assert.equal(decoded(block ?? ''), windowsEnvironmentBlock(git.env));
  });

  it('keeps the command line as long, however large the environment', () => {
    const length = (command: typeof git): number => {
      const { file, args } = jobObjectCommand(command, 'D:\\work\\tree');
      return [file, ...args].join(' ').length;
    };
    const large = { ...git, env: { ...git.env, LARGE: 'x'.repeat(10_000) } };
    assert.equal(length(large), length(git));
  });

  // PowerShell runs in System32, so nothing in a repository's folder can take part in it; the
  // program runs where it was asked to.
  it('runs PowerShell in System32 and gives the helper the working directory', () => {
    const helper = jobObjectCommand(git, 'D:\\work\\tree');
    assert.equal(helper.cwd, 'D:\\WINDOWS\\System32');
    assert.match(script(helper.args), /^\$cwd = .*'(.+)'.*$/m);
    const [, cwd = ''] = /^\$cwd = .*'(.+)'.*$/m.exec(script(helper.args)) ?? [];
    assert.equal(decoded(cwd), 'D:\\work\\tree');
  });

  // Every value goes in as base64, so no quote, $ or backtick in a path or argument can change
  // the script.
  it('gives the helper the application and command line, whatever characters they hold', () => {
    const odd = spawnCommand(
      "C:\\it's $(here)\\tool.exe",
      ["'; Remove-Item C:\\ -Recurse #", '`$x', '\u2019'],
      'win32',
      env,
    );
    const text = script(jobObjectCommand(odd, 'D:\\work').args);
    const value = (name: string): string => {
      const [, base64 = ''] = new RegExp(`^\\$${name} = .*'(.+)'.*$`, 'm').exec(text) ?? [];
      return decoded(base64);
    };
    assert.deepEqual({ application: value('file'), line: value('line') }, jobObjectLine(odd));
  });

  // As node's spawn has it: a relative working directory against this process's, and a relative
  // program against the working directory, never against PowerShell's System32.
  it('resolves a relative working directory and program as node would', () => {
    const tool = spawnCommand('tools\\tool.exe', ['a'], 'win32', env);
    const text = script(jobObjectCommand(tool, 'work\\tree').args);
    const value = (name: string): string => {
      const [, base64 = ''] = new RegExp(`^\\$${name} = .*'(.+)'.*$`, 'm').exec(text) ?? [];
      return decoded(base64);
    };
    const cwd = win32.resolve('work\\tree');
    assert.deepEqual(
      { cwd: value('cwd'), file: value('file'), line: value('line') },
      { cwd, file: win32.join(cwd, 'tools\\tool.exe'), line: 'tools\\tool.exe a' },
    );
  });

  // Windows limits a command line to 32,767 characters; the helper must leave most of it to the
  // program's own arguments.
  it('leaves most of the command line to the program', () => {
    const { file, args } = jobObjectCommand(git, 'D:\\work\\tree');
    const length = [file, ...args].join(' ').length;
    assert.ok(length < 12_000, `the helper's command line takes ${length} characters`);
  });
});

describe('windowsEnvironmentBlock', () => {
  // What CreateProcessW takes as lpEnvironment with CREATE_UNICODE_ENVIRONMENT: name=value
  // entries, sorted by name without regard to case, each ended by NUL, and one more NUL.
  it('lists every variable as name=value, sorted without regard to case, ended by two NULs', () => {
    assert.equal(
      windowsEnvironmentBlock({ b: '2', A: '1', Path: 'C:\\bin', c: 'x=y' }),
      'A=1\0b=2\0c=x=y\0Path=C:\\bin\0\0',
    );
  });

  it('leaves out a variable without a value', () => {
    assert.equal(windowsEnvironmentBlock({ A: '1', B: undefined }), 'A=1\0\0');
  });

  // As node's spawn does on Windows, where names differ only in case: the first in sorted order.
  it('keeps one of the names that differ only in case, the first in sorted order', () => {
    assert.equal(windowsEnvironmentBlock({ Path: 'b', PATH: 'a' }), 'PATH=a\0\0');
  });

  it('is two NULs for an empty environment', () => {
    assert.equal(windowsEnvironmentBlock({}), '\0\0');
  });

  it('keeps every character of a value', () => {
    assert.equal(windowsEnvironmentBlock({ X: 'José ✓ "q"' }), 'X=José ✓ "q"\0\0');
  });
});
