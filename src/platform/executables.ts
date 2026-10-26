// Finding the file a command name runs (architecture §13, executables): through PATH, and on
// Windows also PATHEXT, so `claude` can be found as `claude.cmd` and `foedrum doctor` can show
// what runs. Unlike cmd.exe, it never looks in the current directory, and it skips PATH folders
// that are not absolute, so a repository cannot plant its own `git.exe`.

import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Whether a regular, runnable file is at the path. */
  isExecutable?: (path: string) => boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// A regular file; outside Windows also one this process may run.
const runnableFile =
  (platform: NodeJS.Platform) =>
  (path: string): boolean => {
    try {
      if (!statSync(path).isFile()) return false;
      if (platform !== 'win32') accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

const regularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** An environment variable; on Windows whatever the case of its name (Path, PATHEXT, SYSTEMROOT). */
export const environmentVariable = (
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined =>
  platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
    : env[name];

/** PATHEXT's extensions in lower case, or Windows' default ones when it is not set. */
export const pathExtensions = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] =>
  (environmentVariable(env, 'PATHEXT', platform) || DEFAULT_PATHEXT)
    .split(';')
    .filter((extension) => extension !== '')
    .map((extension) => extension.toLowerCase());

/** PATH's folders in order, unquoted, without the ones that are not absolute. */
export const pathFolders = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] => {
  const path = platform === 'win32' ? win32 : posix;
  return (
    (environmentVariable(env, 'PATH', platform) ?? '')
      .split(path.delimiter)
      .map((folder) => folder.replace(/^"(.*)"$/, '$1'))
      // A relative folder would be checked here but resolved against another directory when the
      // program starts.
      .filter((folder) => path.isAbsolute(folder))
  );
};

/**
 * The path of the file the command name runs, or undefined when none is found. A name with a
 * folder in it is checked as it is, without PATH.
 */
export const resolveExecutable = (
  name: string,
  options: ResolveExecutableOptions = {},
): string | undefined => {
  const { env = process.env, platform = process.platform } = options;
  const { isExecutable = runnableFile(platform) } = options;
  const path = platform === 'win32' ? win32 : posix;
  // On Windows a name gets each PATHEXT extension, unless it already ends in one.
  const extensions = pathExtensions(env, platform);
  const candidates = (base: string): string[] =>
    platform !== 'win32' || extensions.includes(path.extname(base).toLowerCase())
      ? [base]
      : extensions.map((extension) => `${base}${extension}`);
  const folders = name.includes(path.sep) || name.includes('/') ? [''] : pathFolders(env, platform);
  for (const folder of folders) {
    const base = folder === '' ? name : path.join(folder, name);
    const found = candidates(base).find(isExecutable);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Where npm's CLI script is next to a node, or undefined; `tried` lists every place looked. */
export interface NpmCliLookup {
  path: string | undefined;
  tried: string[];
}

export interface FindNpmCliOptions {
  platform?: NodeJS.Platform;
  /** Whether a regular file is at the path. */
  isFile?: (path: string) => boolean;
}

/**
 * npm's CLI script as installed with the node at `execPath`, so npm runs without npm's shims
 * or a shell: `<node dir>/node_modules/npm` on Windows. Elsewhere node is `<prefix>/bin/node`,
 * and npm is in `<prefix>/lib/node_modules/npm` (the nodejs.org builds, nvm, setup-node),
 * `<prefix>/libexec/lib/node_modules/npm` (Homebrew's keg, which macOS resolves node's link to)
 * or `<prefix>/share/nodejs/npm` (Debian's and Ubuntu's npm package), looked at in that order.
 */
export const findNpmCli = (execPath: string, options: FindNpmCliOptions = {}): NpmCliLookup => {
  const { platform = process.platform, isFile = regularFile } = options;
  const path = platform === 'win32' ? win32 : posix;
  const nodeDir = path.dirname(execPath);
  const prefix = path.dirname(nodeDir);
  const npmDirs =
    platform === 'win32'
      ? [path.join(nodeDir, 'node_modules', 'npm')]
      : [
          path.join(prefix, 'lib', 'node_modules', 'npm'),
          path.join(prefix, 'libexec', 'lib', 'node_modules', 'npm'),
          path.join(prefix, 'share', 'nodejs', 'npm'),
        ];
  const tried = npmDirs.map((npmDir) => path.join(npmDir, 'bin', 'npm-cli.js'));
  return { path: tried.find((npmCli) => isFile(npmCli)), tried };
};
