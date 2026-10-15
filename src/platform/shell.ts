// Commands that must go through cmd.exe on Windows (architecture §13, spawning `claude`): a
// `.cmd` or `.bat` file such as npm's `claude.cmd` cannot be started without a shell. Every part
// of the command line is checked against a strict pattern first, so nothing in it can reach
// cmd.exe as syntax; prompts and settings go through stdin and files instead of arguments.

/**
 * The command line for `spawn(line, [], { shell: true })` on Windows: the file and the arguments,
 * those with a space or empty in double quotes. Throws when a part has a character outside
 * letters, digits, space and `_ - . , : = / \ @ + ~`.
 */
export const windowsCommandLine = (_file: string, _args: readonly string[]): string => {
  throw new Error('not implemented');
};
