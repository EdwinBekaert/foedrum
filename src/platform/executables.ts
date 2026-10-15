// Finding the file a command name runs (architecture §13, executables): through PATH, and on
// Windows also PATHEXT, so `claude` can be found as `claude.cmd` and `foedrum doctor` can show
// what runs. Unlike cmd.exe, it never looks in the current directory unless PATH names it, so a
// repository cannot plant its own `git.exe`.

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Whether a regular, runnable file is at the path. */
  isExecutable?: (path: string) => boolean;
}

/** The absolute path of the file the command name runs, or undefined when none is found. */
export const resolveExecutable = (
  _name: string,
  _options: ResolveExecutableOptions = {},
): string | undefined => {
  throw new Error('not implemented');
};
