// The `foedrum` command `foedrum init` writes into a user folder on the PATH (ADR 0210): a shim
// that runs this checkout's entry point with the node on the PATH, until `npx foedrum` replaces
// it. The ports are the platform, its environment and home, the files, and the PATH lookup.

import { posix, win32 } from 'node:path';
import { pathExtensions, pathFolders } from '../platform/executables.ts';
import type { Parsed } from './init.ts';

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
  /**
   * Asks `question` until an answer passes `parse`, or takes the answer its option gives (ADR
   * 0212); throws when standard input has ended, or when the option's answer does not pass.
   */
  ask: <T>(question: string, option: 'shim', parse: (answer: string) => Parsed<T>) => Promise<T>;
  /** A yes or no, `byDefault` for an empty answer, or the one its option gives. */
  confirm: (question: string, option: 'repoint', byDefault: boolean) => Promise<boolean>;
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

/**
 * What init does about the `foedrum` command on this machine, read before any question (ADR 0210,
 * ADR 0212): only say lines, ask whether to point init's shim of another checkout here, or ask
 * which folder to write it into.
 */
export type ShimChoice =
  | { kind: 'said'; lines: string[] }
  | { kind: 'repoint'; question: string; file: string }
  | {
      kind: 'folders';
      question: string;
      /** The numbered folders, said before the question. */
      lines: string[];
      /** Reads an answer: the shim's file in the folder it picks, or `null` for none. */
      parse: (answer: string) => Parsed<string | null>;
      /** Where the shim would go, said on a no. */
      first: string;
    };

/** The shim on the platform of `ports`: whether it is Windows, its paths, shell and text. */
const shimOf = (ports: ShimPorts) => {
  const windows = ports.platform === 'win32';
  const shell = SHELLS[windows ? 'windows' : 'posix'];
  return { windows, path: windows ? win32 : posix, shell, text: shell.text(ports.entry) };
};

/** What init does about the `foedrum` command, read from `ports` without writing anything. */
export const shimChoice = (ports: ShimPorts): ShimChoice => {
  const { platform, env, home, entry } = ports;
  const { windows, path, shell, text } = shimOf(ports);
  if (windows && !pathExtensions(env, platform).includes('.cmd')) {
    return {
      kind: 'said',
      lines: [
        'PATHEXT has no .CMD, so foedrum.cmd would not run as foedrum; the foedrum command is not written',
      ],
    };
  }
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
    const lines = [`No folder on the PATH is inside ${home} to write the foedrum command into.`];
    // Every folder lies inside a root home, so init names none, a system folder least of all.
    if (rootHome) {
      lines.push(
        'A home that is a root folder holds every folder, so init names none; write it by hand into a folder of yours on the PATH:',
        ...indented(text),
      );
      if (!windows) lines.push('and run chmod 755 on it');
      return { kind: 'said', lines };
    }
    // A bin folder of the user's on the PATH only needs making, or making writable.
    const listed = preferred.find((own) => onPath.some((folder) => same(folder, own)));
    const suggested = listed ?? (preferred[0] as string);
    if (listed !== undefined) {
      lines.push(`Create ${suggested}, or make it writable: it is on the PATH already.`);
    } else if (windows) {
      // PowerShell's single-quoted strings write each quote it reads as one twice, typographic
      // ones too.
      const quoted = suggested.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote);
      lines.push(
        `Create ${suggested} and add it to your PATH, in PowerShell:`,
        `  New-Item -ItemType Directory -Force '${quoted}'; [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${quoted}', 'User')`,
      );
    } else {
      lines.push(
        `Create ${suggested} and add this line to your shell's profile (~/.profile, ~/.bashrc or ~/.zshrc):`,
        '  export PATH="$HOME/.local/bin:$PATH"',
      );
    }
    lines.push(...byHand(path.join(suggested, shell.name), text, windows));
    return { kind: 'said', lines };
  }

  // A foedrum there already decides: init's own shim is kept or pointed here, another file is left.
  for (const folder of folders) {
    const file = path.join(folder, shell.name);
    let there: string | undefined;
    try {
      there = ports.read(file);
    } catch (error) {
      // A folder by that name, or a file it may not read: init goes on to doctor.
      return {
        kind: 'said',
        lines: [`Could not read ${file}: ${messageOf(error)}`, ...byHand(file, text, windows)],
      };
    }
    if (there === undefined) continue;
    const runs = there.includes(MARK) ? shell.entryOf(there) : undefined;
    if (runs === undefined) {
      return {
        kind: 'said',
        lines: [`${file} is there and is not a foedrum command init wrote; it is left as it is`],
      };
    }
    if (same(runs, entry)) return { kind: 'said', lines: [`${file} runs this Foedrum already`] };
    return {
      kind: 'repoint',
      file,
      question: `${file} runs the Foedrum in ${checkout(runs)}. Point it at ${checkout(entry)}? [y/N]: `,
    };
  }

  return {
    kind: 'folders',
    question: QUESTION,
    lines: [
      'Folders on the PATH for the foedrum command:',
      ...folders.map((folder, at) => `  ${at + 1}. ${folder}`),
    ],
    parse: (answer) => {
      const given = answer.trim();
      if (/^no?$/i.test(given)) return { value: null };
      const picked = given === '' ? 1 : /^\d+$/.test(given) ? Number(given) : 0;
      const folder = folders[picked - 1];
      if (folder !== undefined) return { value: path.join(folder, shell.name) };
      return { refused: `Answer a number from 1 to ${folders.length}, or n` };
    },
    first: path.join(folders[0] as string, shell.name),
  };
};

/** Offers the `foedrum` command after asking, or says how to write it by hand (ADR 0210). */
export const offerShim = async (ports: ShimPorts, terminal: ShimTerminal): Promise<void> => {
  const { say } = terminal;
  const { windows, text } = shimOf(ports);
  const choice = shimChoice(ports);
  switch (choice.kind) {
    case 'said':
      for (const line of choice.lines) say(line);
      return;
    case 'repoint':
      if (await terminal.confirm(choice.question, 'repoint', false)) {
        write(ports, terminal, choice.file, text, windows);
      } else say(`Kept ${choice.file}`);
      return;
    case 'folders': {
      for (const line of choice.lines) say(line);
      const file = await terminal.ask(choice.question, 'shim', choice.parse);
      if (file === null) for (const line of byHand(choice.first, text, windows)) say(line);
      else write(ports, terminal, file, text, windows);
      return;
    }
    default: {
      const never: never = choice;
      throw new Error(`Unknown choice ${JSON.stringify(never)}`);
    }
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
    for (const line of byHand(file, text, windows)) say(line);
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

/** The shim's lines, each indented to be read apart from init's own. */
const indented = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .slice(0, -1)
    .map((line) => `  ${line}`);

/** Where the shim would go and what it would hold, for the user to write by hand. */
const byHand = (file: string, text: string, windows: boolean): string[] => [
  `Not written. To write it by hand, put these lines in ${file}:`,
  ...indented(text),
  ...(windows ? [] : [`and run: chmod 755 ${file}`]),
];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
