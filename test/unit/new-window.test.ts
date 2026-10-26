// `foedrum brew --new-window` (ADR 0222): the command line that opens a new terminal window running
// `foedrum brew <issue> --take`, built per platform with argument arrays, and its start through a
// fake process runner. No window opens and no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { describe, it } from 'node:test';
import {
  newWindowCommand,
  openInNewWindow,
  type WindowFacts,
} from '../../src/platform/new-window.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';

const unixLine = {
  cwd: '/home/ann/brewery',
  program: '/usr/local/bin/node',
  args: ['/opt/foedrum/src/cli/main.ts', 'brew', '12', '--take'],
};
const windowsLine = {
  cwd: win32.join('D:', 'brewery'),
  program: win32.join('C:', 'Program Files', 'nodejs', 'node.exe'),
  args: [win32.join('D:', 'foedrum', 'src', 'cli', 'main.ts'), 'brew', '12', '--take'],
};
const facts = (
  platform: NodeJS.Platform,
  env: Record<string, string> = {},
  found: readonly string[] = [],
): WindowFacts => ({
  platform,
  env,
  find: (name) => (found.includes(name) ? `/found/${name}` : undefined),
});

describe('newWindowCommand (ADR 0222)', () => {
  it('opens a Windows Terminal tab in the Brewery when wt.exe is on the PATH', () => {
    assert.deepStrictEqual(newWindowCommand(facts('win32', {}, ['wt.exe']), windowsLine), {
      kind: 'launch',
      program: '/found/wt.exe',
      args: ['new-tab', '-d', windowsLine.cwd, windowsLine.program, ...windowsLine.args],
    });
  });

  it("starts a console window through cmd.exe's start otherwise, by cmd's full path", () => {
    const env = { ComSpec: win32.join('C:', 'Windows', 'System32', 'cmd.exe') };
    assert.deepStrictEqual(newWindowCommand(facts('win32', env), windowsLine), {
      kind: 'launch',
      program: env.ComSpec,
      args: [
        '/d',
        '/c',
        'start',
        'foedrum brew',
        '/d',
        windowsLine.cwd,
        windowsLine.program,
        ...windowsLine.args,
      ],
    });
  });

  it('refuses a Windows line cmd.exe would read as more than its words', () => {
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    const line = { ...windowsLine, args: [...windowsLine.args, '--as', 'ann&calc'] };
    assert.equal(newWindowCommand(facts('win32', env), line).kind, 'none');
  });

  it('tells Terminal on macOS to run the line in the Brewery, quoted for the shell and for AppleScript', () => {
    const line = { ...unixLine, cwd: `/Users/ann/the "brewery"`, args: [...unixLine.args, "it's"] };
    assert.deepStrictEqual(newWindowCommand(facts('darwin', {}, ['osascript']), line), {
      kind: 'launch',
      program: '/found/osascript',
      args: [
        '-e',
        `tell application "Terminal" to do script "cd '/Users/ann/the \\"brewery\\"' && '/usr/local/bin/node' '/opt/foedrum/src/cli/main.ts' 'brew' '12' '--take' 'it'\\\\''s'"`,
        '-e',
        'tell application "Terminal" to activate',
      ],
    });
  });

  it('runs $TERMINAL, else x-terminal-emulator, with -e on Linux, in a session of its own', () => {
    const display = { DISPLAY: ':0' };
    const found = ['setsid', 'x-terminal-emulator', 'kitty'];
    assert.deepStrictEqual(newWindowCommand(facts('linux', display, found), unixLine), {
      kind: 'launch',
      program: '/found/setsid',
      args: ['-f', '/found/x-terminal-emulator', '-e', unixLine.program, ...unixLine.args],
    });
    const chosen = newWindowCommand(
      facts('linux', { ...display, TERMINAL: 'kitty' }, found),
      unixLine,
    );
    assert.deepStrictEqual(chosen.kind === 'launch' && chosen.args.slice(0, 2), [
      '-f',
      '/found/kitty',
    ]);
  });

  it('opens no window where there is no desktop: SSH, no display on Linux, or no terminal found', () => {
    const cases: [WindowFacts, RegExp][] = [
      [facts('darwin', { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }, ['osascript']), /SSH/],
      [facts('win32', { SSH_TTY: '/dev/pts/0' }, ['wt.exe']), /SSH/],
      [facts('linux', {}, ['setsid', 'x-terminal-emulator']), /no display/],
      [facts('linux', { WAYLAND_DISPLAY: 'wayland-0' }, ['setsid']), /no terminal/],
      [facts('darwin', {}, []), /osascript/],
      [facts('freebsd', { DISPLAY: ':0' }), /freebsd/],
    ];
    for (const [given, why] of cases) {
      const command = newWindowCommand(given, unixLine);
      assert.equal(command.kind, 'none', JSON.stringify(given));
      assert.match(command.kind === 'none' ? command.why : '', why);
    }
  });
});

describe('openInNewWindow (ADR 0222)', () => {
  const ran: { file: string; args: readonly string[]; cwd: string }[] = [];
  const exec =
    (exitCode: number | null): ExecProcess =>
    async (file, args, { cwd }) => {
      ran.push({ file, args, cwd });
      return { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'no', output: '' };
    };
  const linux = facts('linux', { DISPLAY: ':0' }, ['setsid', 'x-terminal-emulator']);

  it('starts the launcher in the Brewery and says the window opened', async () => {
    ran.length = 0;
    assert.deepStrictEqual(await openInNewWindow(linux, unixLine, exec(0)), { kind: 'opened' });
    assert.deepStrictEqual(
      ran.map(({ file, cwd }) => [file, cwd]),
      [['/found/setsid', unixLine.cwd]],
    );
  });

  it('says why when no window can be opened, or the launcher fails, starting nothing more', async () => {
    ran.length = 0;
    const none = await openInNewWindow(facts('linux'), unixLine, exec(0));
    assert.equal(none.kind, 'none');
    assert.deepStrictEqual(ran, []);
    const failed = await openInNewWindow(linux, unixLine, exec(1));
    assert.deepStrictEqual(failed, { kind: 'none', why: 'setsid exited with code 1: no' });
  });
});
