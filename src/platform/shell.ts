// Commands that must go through cmd.exe on Windows (architecture §13, spawning `claude`): a
// `.cmd` or `.bat` file such as npm's `claude.cmd` cannot be started without a shell. Every part
// of the command line is checked against a strict pattern and put in double quotes, so nothing
// in it can reach cmd.exe as syntax; prompts and settings go through stdin and files instead of
// arguments.

// Letters and digits in any script, and punctuation that is literal inside double quotes. Not
// " % ! ^ (special there too), line breaks, or anything a path or a flag does not need.
const SAFE = /^[\p{L}\p{N} _\-.,:=/\\@+~'()]*$/u;

// Before the closing quote, a backslash would escape it for the program's argument parser.
const quoted = (part: string): string => `"${part.replace(/(\\+)$/, '$1$1')}"`;

/**
 * The command line for `spawn(line, [], { shell: true })` on Windows: the file and the
 * arguments, each in double quotes. Unquoted, cmd.exe would read a `/` in the file as a switch.
 * Throws when a part has a character outside letters, digits, space and
 * `_ - . , : = / \ @ + ~ ' ( )`.
 */
export const windowsCommandLine = (file: string, args: readonly string[]): string => {
  const unsafe = (what: string, part: string): Error =>
    new Error(
      `${what} ${JSON.stringify(part)} cannot go through the Windows shell: only letters, digits, spaces and _ - . , : = / \\ @ + ~ ' ( ) can`,
    );
  if (file === '' || !SAFE.test(file)) throw unsafe('the file', file);
  args.forEach((arg, index) => {
    if (!SAFE.test(arg)) throw unsafe(`argument ${index + 1}`, arg);
  });
  return [file, ...args].map(quoted).join(' ');
};
