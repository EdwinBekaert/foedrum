// Commands that must go through cmd.exe on Windows (architecture §13, spawning `claude`): a
// `.cmd` or `.bat` file such as npm's `claude.cmd` cannot be started without a shell. Every part
// of the command line is checked against a strict pattern first, so nothing in it can reach
// cmd.exe as syntax; prompts and settings go through stdin and files instead of arguments.

// Letters and digits in any script, and a few punctuation marks that mean nothing to cmd.exe.
const SAFE = /^[\p{L}\p{N} _\-.,:=/\\@+~]*$/u;

const quoted = (part: string): string =>
  // Before the closing quote, a backslash would escape it for the program's argument parser.
  part === '' || part.includes(' ') ? `"${part.replace(/(\\+)$/, '$1$1')}"` : part;

/**
 * The command line for `spawn(line, [], { shell: true })` on Windows: the file and the arguments,
 * those with a space or empty in double quotes. Throws when a part has a character outside
 * letters, digits, space and `_ - . , : = / \ @ + ~`.
 */
export const windowsCommandLine = (file: string, args: readonly string[]): string => {
  const unsafe = (what: string, part: string): Error =>
    new Error(
      `${what} ${JSON.stringify(part)} cannot go through the Windows shell: only letters, digits, spaces and _ - . , : = / \\ @ + ~ can`,
    );
  if (file === '' || !SAFE.test(file)) throw unsafe('the file', file);
  args.forEach((arg, index) => {
    if (!SAFE.test(arg)) throw unsafe(`argument ${index + 1}`, arg);
  });
  return [file, ...args].map(quoted).join(' ');
};
