// A new terminal window that runs a command line (ADR 0222): `/foedrum:brew` opens an interactive
// step's session through `foedrum brew <issue> --new-window`, since a plugin command cannot hand a
// terminal over (ADR 0126). One command line per platform, with argument arrays: Windows Terminal or
// cmd.exe's start, Terminal through osascript, or the desktop's terminal with -e.

import { win32 } from 'node:path';
import { environmentVariable } from './executables.ts';
import type { LaunchProcess } from './processes.ts';
import { windowsCommandLine } from './shell.ts';

/** What the launcher is chosen from: the platform, its variables, and the programs on the PATH. */
export interface WindowFacts {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** The full path of a program on the PATH, or `undefined` when it is not there. */
  find: (name: string) => string | undefined;
}

/** The command line the new window runs, in the folder it runs in. */
export interface WindowLine {
  cwd: string;
  program: string;
  args: readonly string[];
  /** The environment the launcher, and through it the window, gets; the facts' by default. */
  env?: Readonly<Record<string, string | undefined>>;
}

export type WindowLaunch =
  /** `env`: variables the launcher needs besides the line's. */
  | { kind: 'launch'; program: string; args: string[]; env?: Record<string, string> }
  | { kind: 'none'; why: string };

const none = (why: string): WindowLaunch => ({ kind: 'none', why });

/** `text` as one POSIX shell word, in single quotes. */
const shellWord = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** `text` inside an AppleScript string's double quotes. */
const appleString = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

/** The launcher that opens a window running `line`, or why none can be opened here. */
export function newWindowCommand(facts: WindowFacts, line: WindowLine): WindowLaunch {
  const { platform, env, find } = facts;
  // A window would open on the desktop of the machine, not where the person sits.
  if (env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined) {
    return none('this is an SSH session, whose desktop is not where you sit');
  }
  const command = [line.program, ...line.args];
  switch (platform) {
    case 'win32': {
      // Both read the line as cmd.exe's and Windows Terminal's syntax: only plain words pass, and
      // an aliased order's #, which neither reads as syntax.
      const plain = (word: string): string => word.replaceAll('#', '');
      try {
        windowsCommandLine(line.program, [line.cwd, ...line.args].map(plain));
      } catch (error) {
        return none((error as Error).message);
      }
      const terminal = find('wt.exe');
      if (terminal !== undefined) {
        return { kind: 'launch', program: terminal, args: ['new-tab', '-d', line.cwd, ...command] };
      }
      // cmd.exe by its full path, never the working directory's programs, as the runner starts it.
      const root = environmentVariable(env, 'SYSTEMROOT', 'win32') ?? 'C:\\Windows';
      return {
        kind: 'launch',
        program: win32.join(root, 'System32', 'cmd.exe'),
        args: ['/d', '/c', 'start', 'foedrum brew', '/d', line.cwd, ...command],
        env: { NoDefaultCurrentDirectoryInExePath: '1' },
      };
    }
    case 'darwin': {
      const osascript = find('osascript');
      if (osascript === undefined) return none('osascript is not on the PATH to open Terminal');
      const script = [`cd ${shellWord(line.cwd)}`, command.map(shellWord).join(' ')].join(' && ');
      return {
        kind: 'launch',
        program: osascript,
        args: [
          '-e',
          `tell application "Terminal" to do script "${appleString(script)}"`,
          '-e',
          'tell application "Terminal" to activate',
        ],
      };
    }
    case 'linux': {
      if (env.DISPLAY === undefined && env.WAYLAND_DISPLAY === undefined) {
        return none('there is no display to open a window on');
      }
      const named = env.TERMINAL === undefined ? undefined : find(env.TERMINAL);
      const terminal = named ?? find('x-terminal-emulator');
      // In a session of its own, so the launch returns while the window stays open.
      const setsid = find('setsid');
      if (terminal === undefined || setsid === undefined) {
        return none(
          'no terminal was found: set TERMINAL, or install x-terminal-emulator and setsid',
        );
      }
      return { kind: 'launch', program: setsid, args: ['-f', terminal, '-e', ...command] };
    }
    default:
      return none(`foedrum opens no window on ${platform}`);
  }
}

/** How long a launcher may take: each hands the window over and returns. */
const LAUNCH_MS = 30_000;

/** Opens a window running `line` through `exec`, or says why it could not. */
export async function openInNewWindow(
  facts: WindowFacts,
  line: WindowLine,
  exec: LaunchProcess,
): Promise<{ kind: 'opened' } | { kind: 'none'; why: string }> {
  const launch = newWindowCommand(facts, line);
  if (launch.kind === 'none') return launch;
  // The line's environment, else the machine's, with what the launcher needs over it.
  const env = { ...(line.env ?? facts.env), ...launch.env };
  const options = { cwd: line.cwd, timeoutMs: LAUNCH_MS, env };
  const result = await exec(launch.program, launch.args, options);
  if (result.exitCode === 0) return { kind: 'opened' };
  const name = launch.program.split(/[\\/]/).at(-1) ?? launch.program;
  const said = result.stderr.trim();
  const ended = result.exitCode === null ? 'did not finish' : `exited with code ${result.exitCode}`;
  return { kind: 'none', why: `${name} ${ended}${said === '' ? '' : `: ${said}`}` };
}
