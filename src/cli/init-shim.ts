// The `foedrum` command `foedrum init` writes into a user folder on the PATH (ADR 0210): a shim
// that runs this checkout's entry point with the node on the PATH, until `npx foedrum` replaces
// it. The ports are the platform, its environment and home, the files, and the PATH lookup.

import { posix, win32 } from 'node:path';
import { pathExtensions, pathFolders } from '../platform/executables.ts';

export interface ShimPorts {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The user's home, the user profile on Windows. */
  home: string;
  /** The entry point of the Foedrum that runs: `<checkout>/src/cli/main.ts`. */
  entry: string;
  /** Whether `folder` is there as a folder this process may write in. */
  writable: (folder: string) => boolean;
  /** The text of the file at `path`, or `undefined` when there is none. */
  read: (path: string) => string | undefined;
  /** Writes `text` at `path`, runnable (mode 0755) when `executable`. */
  write: (path: string, text: string, executable: boolean) => void;
  /** The file a command name runs in this terminal (`resolveExecutable`). */
  resolve: (name: string) => string | undefined;
}

export interface ShimTerminal {
  /** Asks one question and gives its answer; throws when standard input has ended. */
  answer: (question: string) => Promise<string>;
  say: (line: string) => void;
}

/** The comment line by which init knows a shim it wrote. */
const MARK = 'The foedrum command, written by foedrum init (ADR 0210)';
const QUESTION = 'Write the foedrum command into which folder? [1, or n for none]: ';

/** The shim for `entry` on a platform: its file name, its text, and how its line names `entry`. */
interface Shell {
  name: string;
  text: (entry: string) => string;
  /** The entry point a shim's text runs, when init wrote it. */
  entryOf: (text: string) => string | undefined;
}

const POSIX_RUN = /^exec node '((?:[^']|'\\'')*)' "\$@"$/m;
const WINDOWS_RUN = /^node "([^"]*)" %\*\r?$/m;

const SHELLS: Readonly<Record<'posix' | 'windows', Shell>> = {
  posix: {
    name: 'foedrum',
    // Single quotes keep every character as it is, a `'` written as `'\''`.
    text: (entry) => `#!/bin/sh\n# ${MARK}\nexec node '${entry.replaceAll("'", `'\\''`)}' "$@"\n`,
    entryOf: (text) => POSIX_RUN.exec(text)?.[1]?.replaceAll(`'\\''`, "'"),
  },
  windows: {
    name: 'foedrum.cmd',
    // A Windows path holds no `"`; cmd reads `%` as a variable unless it is doubled. cmd looks for
    // `node` in the working directory first unless told not to, as Foedrum's runner does (ADR 0031).
    text: (entry) =>
      [
        '@echo off',
        `rem ${MARK}`,
        'setlocal',
        'set "NoDefaultCurrentDirectoryInExePath=1"',
        `node "${entry.replaceAll('%', '%%')}" %*`,
        '',
      ].join('\r\n'),
    entryOf: (text) => WINDOWS_RUN.exec(text)?.[1]?.replaceAll('%%', '%'),
  },
};

/** Folders a tool manages, which move or vanish with it: npm's, nvm's, Python's and cargo's. */
const managed = (segments: readonly string[]): boolean =>
  segments.some(
    (segment, at) =>
      ['.cargo', '.nvm', 'nvm', '.npm-global', '.pyenv'].includes(segment) ||
      /^python\d*$/.test(segment) ||
      (segment === 'npm' && segments[at - 1] === 'roaming'),
  ) || segments.at(-1) === 'scripts';

/** Offers the `foedrum` command after asking, or says how to write it by hand (ADR 0210). */
export const offerShim = async (ports: ShimPorts, terminal: ShimTerminal): Promise<void> => {
  const { platform, env, home, entry } = ports;
  const { say } = terminal;
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const shell = SHELLS[windows ? 'windows' : 'posix'];
  if (windows && !pathExtensions(env, platform).includes('.cmd')) {
    say(
      'PATHEXT has no .CMD, so foedrum.cmd would not run as foedrum; the foedrum command is not written',
    );
    return;
  }
  const text = shell.text(entry);
  const same = (a: string, b: string): boolean =>
    windows
      ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      : path.resolve(a) === path.resolve(b);
  const checkout = (main: string): string => path.dirname(path.dirname(path.dirname(main)));

  // The PATH's folders inside the home that are there and writable, each once, in the order
  // offered: the user's own bin folders, the others, then the ones a tool manages.
  // A home that is a root folder (`/`, `C:\`) would hold every folder, system ones too.
  const rootHome = path.dirname(path.resolve(home)) === path.resolve(home);
  const onPath = pathFolders(env, platform);
  const inside = onPath.filter((folder, at, all) => {
    const relative = path.relative(home, folder);
    if (rootHome || relative === '' || path.isAbsolute(relative)) return false;
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
    if (all.findIndex((other) => same(other, folder)) !== at) return false;
    // Windows keeps its app execution aliases there.
    if (windows && path.basename(path.resolve(folder)).toLowerCase() === 'windowsapps') {
      return false;
    }
    return ports.writable(folder);
  });
  const segments = (folder: string): string[] =>
    path
      .relative(home, folder)
      .split(path.sep)
      .map((segment) => (windows ? segment.toLowerCase() : segment));
  const preferred = [path.join(home, '.local', 'bin'), path.join(home, 'bin')];
  const rank = (folder: string): number => {
    const first = preferred.findIndex((own) => same(own, folder));
    if (first >= 0) return first;
    return managed(segments(folder)) ? 3 : 2;
  };
  const folders = inside.toSorted((a, b) => rank(a) - rank(b));

  if (folders.length === 0) {
    say(`No folder on the PATH is inside ${home} to write the foedrum command into.`);
    // Every folder lies inside a root home, so init names none, a system folder least of all.
    if (rootHome) {
      say(
        'A home that is a root folder holds every folder, so init names none; write it by hand into a folder of yours on the PATH:',
      );
      for (const line of text.split(/\r?\n/).slice(0, -1)) say(`  ${line}`);
      if (!windows) say('and run chmod 755 on it');
      return;
    }
    // A bin folder of the user's on the PATH only needs making, or making writable.
    const listed = preferred.find((own) => onPath.some((folder) => same(folder, own)));
    const suggested = listed ?? (preferred[0] as string);
    if (listed !== undefined) {
      say(`Create ${suggested}, or make it writable: it is on the PATH already.`);
    } else if (windows) {
      // PowerShell's single-quoted strings write each quote it reads as one twice, typographic
      // ones too.
      const quoted = suggested.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote);
      say(`Create ${suggested} and add it to your PATH, in PowerShell:`);
      say(
        `  New-Item -ItemType Directory -Force '${quoted}'; [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${quoted}', 'User')`,
      );
    } else {
      say(
        `Create ${suggested} and add this line to your shell's profile (~/.profile, ~/.bashrc or ~/.zshrc):`,
      );
      say('  export PATH="$HOME/.local/bin:$PATH"');
    }
    byHand(say, path.join(suggested, shell.name), text, windows);
    return;
  }

  // A foedrum there already decides: init's own shim is kept or pointed here, another file is left.
  for (const folder of folders) {
    const file = path.join(folder, shell.name);
    let there: string | undefined;
    try {
      there = ports.read(file);
    } catch (error) {
      // A folder by that name, or a file it may not read: init goes on to doctor.
      say(`Could not read ${file}: ${messageOf(error)}`);
      byHand(say, file, text, windows);
      return;
    }
    if (there === undefined) continue;
    const runs = there.includes(MARK) ? shell.entryOf(there) : undefined;
    if (runs === undefined) {
      say(`${file} is there and is not a foedrum command init wrote; it is left as it is`);
      return;
    }
    if (same(runs, entry)) {
      say(`${file} runs this Foedrum already`);
      return;
    }
    const answer = await terminal.answer(
      `${file} runs the Foedrum in ${checkout(runs)}. Point it at ${checkout(entry)}? [y/N]: `,
    );
    if (/^y(?:es)?$/i.test(answer.trim())) write(ports, terminal, file, text, windows);
    else say(`Kept ${file}`);
    return;
  }

  say('Folders on the PATH for the foedrum command:');
  folders.forEach((folder, at) => {
    say(`  ${at + 1}. ${folder}`);
  });
  for (;;) {
    const answer = (await terminal.answer(QUESTION)).trim();
    if (/^no?$/i.test(answer)) {
      byHand(say, path.join(folders[0] as string, shell.name), text, windows);
      return;
    }
    const picked = answer === '' ? 1 : /^\d+$/.test(answer) ? Number(answer) : 0;
    const folder = folders[picked - 1];
    if (folder !== undefined) {
      write(ports, terminal, path.join(folder, shell.name), text, windows);
      return;
    }
    say(`  Answer a number from 1 to ${folders.length}, or n`);
  }
};

/** Writes the shim at `file`, then says what `foedrum` runs in this terminal. */
const write = (
  ports: ShimPorts,
  { say }: ShimTerminal,
  file: string,
  text: string,
  windows: boolean,
): void => {
  try {
    ports.write(file, text, !windows);
  } catch (error) {
    // Windows' ACLs can keep the user out of a folder that passes `writable`; init goes on.
    say(`Could not write ${file}: ${messageOf(error)}`);
    byHand(say, file, text, windows);
    return;
  }
  say(`Wrote ${file}`);
  // Every folder offered is on the PATH, so a new terminal finds it unless an earlier one wins.
  const runs = ports.resolve('foedrum');
  if (runs === undefined) say('Open a new terminal to run foedrum');
  else if (windows ? runs.toLowerCase() === file.toLowerCase() : runs === file) {
    say('foedrum runs it in this terminal');
  } else say(`foedrum runs ${runs} in this terminal, which is earlier on the PATH`);
};

/** Where the shim would go and what it would hold, for the user to write by hand. */
const byHand = (say: ShimTerminal['say'], file: string, text: string, windows: boolean): void => {
  say(`Not written. To write it by hand, put these lines in ${file}:`);
  for (const line of text.split(/\r?\n/).slice(0, -1)) say(`  ${line}`);
  if (!windows) say(`and run: chmod 755 ${file}`);
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
