// Claude Code PreToolUse hook: blocks force pushes, deleting or mirroring pushes and
// `gh pr merge` and pushes from a detached HEAD, runs `npm run check` before `git push` and
// `gh pr create`, and lets `gh pr ready` through only when the pull request has the /brew-review
// summary for its head (#154) or changes only plain documentation (#183). It also blocks npx and
// its relatives when they would run a package the lockfile did not install (#175), and a recursive
// delete of a path built from a variable or a substitution (#281). The checks run in the tree the
// command pushes: the directory it changes into with cd, git -C and the like (#132).
// Wired in .claude/settings.json as `node "${CLAUDE_PROJECT_DIR}/scripts/precheck.ts"`, without
// npm, which cost about 0.4 s per call (#41); the check runs npm's CLI found next to this node,
// without a shell.
// Exit 0 lets the tool call through; exit 2 blocks it and shows stderr to Claude.
// It runs before every Bash and PowerShell call, so input that cannot name git or gh exits
// before any parsing, and the module has no static imports.
//
// The command is read the way bash and PowerShell would read it, both ways, and blocked when
// either reading pushes or merges (#42). Quotes are honoured; wrapper words (env, time, xargs,
// Start-Process, …) are skipped; what other shells and evaluators run (bash -c, pwsh -Command,
// cmd /c, iex, eval) is read as a command too; a git or gh alias that would push, merge or open a
// pull request is blocked where it is defined; and a program or subcommand computed at run time
// is assumed to be the worst it could be. Arguments computed at run time are not evaluated.

export interface CheckResult {
  ok: boolean;
  output: string;
}

export type RunCheck = (cwd: string) => Promise<CheckResult>;

export interface HookResult {
  exitCode: 0 | 2;
  stderr: string;
}

const MAX_OUTPUT_CHARS = 4000;
// Case-insensitive because `GIT push` works on Windows; \u because JSON can escape any letter;
// push, merge and ready for a git or gh whose name is computed at run time; pwsh and powershell
// for an encoded command; npx, npm, dlx and bun for a package runner (#175).
const MAY_NEED_THE_GATE = /git|gh|push|merge|ready|pwsh|powershell|npx|npm|dlx|bun|\\u/i;
// A delete (rm, rd, ri, del, erase, Remove-Item) of a path that may hold a variable or a
// substitution ($, %, a backtick or PowerShell's ( ), read before the shells' characters are
// dropped) (#281).
const MAY_DELETE = /rm|rd|ri|del|erase|remove/i;
const MAY_COMPUTE = /[$%`(]/;
const mayNeedTheGate = (text: string): boolean => {
  const plain = normalised(text);
  return MAY_NEED_THE_GATE.test(plain) || (MAY_DELETE.test(plain) && MAY_COMPUTE.test(text));
};

// PowerShell reads typographic quotes as quotes; bash does not.
const foldQuotes = (text: string): string => text.replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"');

// The raw hook input, or its command, without the quotes and escape characters that bash,
// PowerShell and cmd drop, so a name they split (gi''t, g\it, g`it, g^h) still matches the
// pre-filter. A backslash before u stays, for a JSON escape.
const normalised = (input: string): string => foldQuotes(input).replace(/["'`^]|\\(?!u)/g, '');
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
// gh flags that can appear before the `pr` action and take the next token as their value.
const GH_OPTIONS_WITH_VALUE = new Set(['-R', '--repo', '--hostname']);
// How deep commands may nest (a shell that runs a shell …) before the gate gives up and blocks,
// and how many commands it reads in all.
const MAX_DEPTH = 8;
const MAX_READS = 2000;

const FORCE_PUSH_BLOCKED =
  'Force push is blocked: update a pushed branch by merging origin/main; never rebase or force-push a branch that has been pushed (CLAUDE.md).';
const DELETE_PUSH_BLOCKED =
  'Deleting or mirroring remote refs with git push is blocked: ask a maintainer to delete remote branches.';
const PR_MERGE_BLOCKED =
  '`gh pr merge` is blocked: pull requests are merged by a maintainer, never from a Claude Code session.';
const COMPUTED_PR_ACTION_BLOCKED =
  '`gh pr` with an action computed at run time is blocked: the gate cannot tell it from `gh pr merge`.';
const ALIAS_BLOCKED =
  'Defining a git or gh alias that pushes, merges, opens a pull request or marks one ready is blocked: run git push, gh pr create or gh pr ready as it is, so the gate sees it.';
const READY_COMPUTED_BLOCKED =
  'gh pr ready with a pull request or repository computed at run time is blocked: give them as they are, so the gate can find the review summary.';
const READY_API_BLOCKED =
  'Marking a pull request ready through gh api is blocked: run gh pr ready <n>, so the gate can check its /brew-review summary.';
const TOO_DEEP_BLOCKED =
  'This command nests shells or commands too deeply for the gate to check: run git push, gh pr create and gh pr ready as plain commands.';
const UNREADABLE_QUERY_BLOCKED =
  'gh api graphql with a query the gate cannot read (from a file, --input or a variable) is blocked: give the query inline, so the gate can tell that it does not merge a pull request or mark one ready.';
const READY_COMBINED_BLOCKED =
  'gh pr ready is blocked in the same command as git push or gh pr create: the gate reads the pull request before the command runs, so it would check the old head: run it as a command of its own.';
const READY_GH_REPO_BLOCKED =
  'gh pr ready is blocked in a command that mentions GH_REPO or GH_HOST: the gate looks the pull request up without them; give the repository with -R instead.';
const PUSH_PLACE_BLOCKED =
  'git push is blocked: it runs in a directory computed at run time (such as cd "$d" or git -C $d), so the gate cannot tell which tree to check: push from inside the worktree, or name its path as it is.';
const CREATE_PLACE_BLOCKED =
  'gh pr create is blocked: it runs in a directory computed at run time (such as cd "$d"), so the gate cannot tell which tree to check: run it from inside the worktree, or name its path as it is.';
const READY_PLACE_BLOCKED =
  'gh pr ready is blocked: it runs in a directory computed at run time (such as cd "$d"), so the gate cannot tell which pull request it marks ready: give the pull request number.';
const manyPlacesBlocked = (dirs: string[]): string =>
  `This command pushes or opens pull requests from more than one directory (${dirs.join(', ')}), or the gate read its directory two ways (write the path with /): the gate checks one tree per command; run each from a command of its own.`;
const outsideBlocked = (what: string, dir: string): string =>
  `${what} is blocked: it runs in ${dir}, outside the project this session works in, so the gate does not run that tree's code: ${what === 'git push' ? 'push' : `run ${what}`} from inside that checkout.`;
const VARIABLE_DELETE_BLOCKED =
  'A recursive delete of a path built from a variable or a substitution is blocked: an empty or wrong value removes the wrong tree; write the literal path, such as `rm -rf .foedrum/tmp/218/run` (CLAUDE.md).';
const downloadBlocked = (run: string): string =>
  `\`${run}\` would download a package that isn't in package-lock.json. Use the project's tools: \`npm run lint -- --write\` formats with Biome.`;
const movedRunBlocked = (run: string): string =>
  `\`${run}\` is blocked in a command that changes directory: the gate looks for it in node_modules/.bin where the command starts, and npx would look where it runs. Run it as a command of its own, from the folder whose node_modules it uses.`;
// A name node_modules/.bin can hold, and nothing that reaches out of it; no trailing dot, which
// Windows drops.
const BINARY_NAME = /^[A-Za-z0-9](?:[\w.-]*[\w-])?$/;
// The names Windows reads as a device in any folder, with or without an extension.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

// A shell's reading of a command line. Git Bash runs the Bash tool's commands, so a tool's command
// is read in its own shell; what it runs in turn may be either, so that is read both ways.
type Dialect = 'bash' | 'powershell';
const DIALECTS: readonly Dialect[] = ['bash', 'powershell'];
const TOOL_DIALECTS = new Map<unknown, readonly Dialect[]>([
  ['Bash', ['bash']],
  ['PowerShell', ['powershell']],
]);

// A word of a command after quote removal. `dynamic` when part of it is computed at run time (a
// variable or a substitution); `quoted` when it starts with a quote, which PowerShell reads as a
// value, never as a parameter name.
interface Word {
  text: string;
  dynamic: boolean;
  quoted: boolean;
}

interface Lexed {
  // The simple commands, split at ; & | ( ) { } and line breaks outside quotes.
  segments: Word[][];
  // The content of every quoted string.
  strings: string[];
  // The commands inside $( … ), PowerShell's @( … ) and bash's ` … `.
  substitutions: string[];
  // A quote or substitution never closes, so neither shell would run the command as written.
  unclosed: boolean;
}

const SEPARATORS = new Set([';', '&', '|', '(', ')', '{', '}', '\n', '\r']);

// The index just past the `)` that closes the `(` at `open`, or -1.
const closingParen = (text: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return -1;
};

// Whether a {name} without spaces, such as gh's {owner}, starts at i.
const PLACEHOLDER = /\{\w+\}/y;
const placeholderAt = (command: string, i: number): boolean => {
  PLACEHOLDER.lastIndex = i;
  return PLACEHOLDER.test(command);
};

const lex = (source: string, dialect: Dialect): Lexed => {
  const command = dialect === 'powershell' ? foldQuotes(source) : source;
  const escapeChar = dialect === 'bash' ? '\\' : '`';
  const lexed: Lexed = { segments: [], strings: [], substitutions: [], unclosed: false };
  let segment: Word[] = [];
  let word: Word | undefined;
  const add = (text: string, dynamic = false, quoted = false): Word => {
    word ??= { text: '', dynamic: false, quoted };
    word.text += text;
    word.dynamic ||= dynamic;
    return word;
  };
  const endWord = () => {
    if (word !== undefined) segment.push(word);
    word = undefined;
  };
  const endSegment = () => {
    endWord();
    if (segment.length > 0) lexed.segments.push(segment);
    segment = [];
  };

  // An expansion at i ($name, ${…}, $(…), @(…), bash's `…` and $'…'): adds it to the word and
  // returns the index after it, or -1 when it never closes.
  const expansion = (i: number): number => {
    const sign = command[i] ?? '';
    const next = command[i + 1];
    if (sign === '`') {
      const end = command.indexOf('`', i + 1);
      if (end < 0) return -1;
      lexed.substitutions.push(command.slice(i + 1, end));
      add(command.slice(i, end + 1), true);
      return end + 1;
    }
    if (next === '(') {
      const end = closingParen(command, i + 1);
      if (end < 0) return -1;
      lexed.substitutions.push(command.slice(i + 2, end - 1));
      add(command.slice(i, end), sign === '$');
      return end;
    }
    if (next === '{') {
      const end = command.indexOf('}', i + 2);
      if (end < 0) return -1;
      add(command.slice(i, end + 1), true);
      return end + 1;
    }
    if (next === "'" && dialect === 'bash') {
      // $'…': a backslash escapes the next character, a quote too.
      let end = i + 2;
      while (end < command.length && command[end] !== "'") end += command[end] === '\\' ? 2 : 1;
      if (end >= command.length) return -1;
      lexed.strings.push(command.slice(i + 2, end));
      add(command.slice(i, end + 1), true);
      return end + 1;
    }
    add(sign, sign === '$');
    return i + 1;
  };

  // A '…' string at i: literal, but PowerShell doubles a quote inside it.
  const singleQuoted = (i: number): number => {
    let text = '';
    let j = i + 1;
    for (;;) {
      if (j >= command.length) return -1;
      if (command[j] === "'") {
        if (dialect === 'bash' || command[j + 1] !== "'") break;
        j++;
      }
      text += command[j];
      j++;
    }
    lexed.strings.push(text);
    add(text, false, true);
    return j + 1;
  };

  // A "…" string at i, with its escapes and expansions.
  const doubleQuoted = (i: number): number => {
    const quoted = add('', false, true);
    const start = quoted.text.length;
    let j = i + 1;
    while (j < command.length) {
      const char = command[j] ?? '';
      const next = command[j + 1] ?? '';
      if (char === '"' && dialect === 'powershell' && next === '"') {
        add('"');
        j += 2;
      } else if (char === '"') {
        lexed.strings.push(quoted.text.slice(start));
        return j + 1;
      } else if (char === escapeChar && (dialect === 'powershell' || '$`"\\\n'.includes(next))) {
        add(next);
        j += 2;
      } else if (char === '$' || (char === '`' && dialect === 'bash')) {
        j = expansion(j);
        if (j < 0) return -1;
      } else {
        add(char);
        j++;
      }
    }
    return -1;
  };

  let i = 0;
  while (i >= 0 && i < command.length) {
    const char = command[i] ?? '';
    if (char === escapeChar) {
      // A line continuation, before LF or CRLF, joins the lines.
      const next = command[i + 1];
      const crlf = next === '\r' && command[i + 2] === '\n';
      add(next === '\n' || crlf ? '' : (next ?? ''));
      i += crlf ? 3 : 2;
    } else if (char === ' ' || char === '\t') {
      endWord();
      i++;
    } else if (char === '(' && dialect === 'powershell' && isDelete(segment[0] ?? word)) {
      // An argument of a delete: PowerShell computes it, as in (Join-Path $root run) (#281).
      const end = closingParen(command, i);
      if (end >= 0) {
        lexed.substitutions.push(command.slice(i + 1, end - 1));
        add(command.slice(i, end), true);
      }
      i = end;
    } else if (char === '{' && dialect === 'bash' && placeholderAt(command, i)) {
      // Bash reserves a brace only as a word of its own, so gh's placeholders
      // (repos/{owner}/{repo}/…) are text in a word (#297); PowerShell makes them script blocks.
      const end = command.indexOf('}', i) + 1;
      add(command.slice(i, end));
      i = end;
    } else if (SEPARATORS.has(char)) {
      endSegment();
      i++;
    } else if (char === "'") {
      i = singleQuoted(i);
    } else if (char === '"') {
      i = doubleQuoted(i);
    } else if (
      char === '$' ||
      (char === '`' && dialect === 'bash') ||
      (char === '@' && command[i + 1] === '(' && dialect === 'powershell')
    ) {
      i = expansion(i);
    } else {
      add(char);
      i++;
    }
  }
  lexed.unclosed = i < 0;
  endSegment();
  return lexed;
};

// The program a word names: the last part of a path, lowercased, without .exe, .cmd, .bat, .com
// or .ps1, so `C:\Program Files\Git\cmd\git.exe` is git and npm's `npx.ps1` shim is npx.
const programName = (text: string): string =>
  (text.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');

// The program of a word computed at run time: it may be git or gh.
const COMPUTED = '$';

// Where a command runs: the directories it changes into from the hook's working directory, in
// order, or undefined when one of them is computed at run time (#132).
type Place = readonly string[] | undefined;

// A change of directory: the path as written, or undefined when it is computed at run time.
type Chdir = string | undefined;

const moveTo = (place: Place, chdir: Chdir): Place =>
  place === undefined || chdir === undefined ? undefined : [...place, chdir];

interface Invocation {
  program: string;
  args: Word[];
  // The word that changes directory (cd, pushd, Set-Location, …), when the command is one.
  moves?: Word;
  // The directories a wrapper runs the command in (env -C).
  chdirs: Chdir[];
}

// A word that runs the command after it: its options, those of them that take a value, the
// options whose value is itself a command, how many operands come before the command, and the
// options that run it in another directory, whose path the gate can resolve unless it is `foreign`.
interface Wrapper {
  withValue: readonly string[];
  runs?: readonly string[];
  operands?: number;
  chdir?: readonly string[];
  foreign?: boolean;
}

const WRAPPERS = new Map<string, Wrapper>([
  ['builtin', { withValue: [] }],
  ['command', { withValue: [] }],
  [
    'env',
    {
      withValue: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
      runs: ['-S', '--split-string'],
      chdir: ['-C', '--chdir'],
    },
  ],
  ['exec', { withValue: ['-a'] }],
  // wsl runs git in Linux against the same checkout; -e ends its options like --. Its --cd is a
  // Linux path.
  [
    'wsl',
    {
      withValue: ['-d', '--distribution', '-u', '--user', '--cd', '--shell-type'],
      chdir: ['--cd'],
      foreign: true,
    },
  ],
  ['nice', { withValue: ['-n', '--adjustment'] }],
  ['nohup', { withValue: [] }],
  [
    'sudo',
    {
      withValue: ['-u', '--user', '-g', '--group', '-C', '-D', '--chdir', '-h', '-p', '-r', '-t'],
      chdir: ['-D', '--chdir'],
    },
  ],
  ['time', { withValue: ['-f', '--format', '-o', '--output'] }],
  ['timeout', { withValue: ['-s', '--signal', '-k', '--kill-after'], operands: 1 }],
  [
    'xargs',
    {
      withValue: [
        '-a',
        '--arg-file',
        '-d',
        '--delimiter',
        '-E',
        '-I',
        '-L',
        '--max-lines',
        '-n',
        '--max-args',
        '-P',
        '--max-procs',
        '-s',
        '--max-chars',
      ],
    },
  ],
]);

// npx and the commands that run a package the way it does, by the words that start them: a
// wrapper that downloads the program it runs when the lockfile did not install it (#175). The
// options in `packages` name packages to download, those in `moves` the folder to look in, and a
// runner that `alwaysDownloads` fetches the package even when node_modules/.bin has it.
interface PackageRunner extends Wrapper {
  packages: readonly string[];
  moves?: readonly string[];
  alwaysDownloads?: boolean;
}
const NPX: PackageRunner = {
  withValue: ['-p', '--package', '-c', '--call', '--prefix'],
  runs: ['-c', '--call'],
  packages: ['-p', '--package'],
  moves: ['--prefix'],
};
const DLX: PackageRunner = {
  withValue: ['-p', '--package'],
  packages: ['-p', '--package'],
  alwaysDownloads: true,
};
const BUNX: PackageRunner = { withValue: ['-p', '--package'], packages: ['-p', '--package'] };
const PACKAGE_RUNNERS = new Map<string, PackageRunner>([
  ['npx', NPX],
  ['npm exec', NPX],
  ['npm x', NPX],
  ['pnpm dlx', DLX],
  ['pnpx', DLX],
  ['yarn dlx', DLX],
  ['bunx', BUNX],
  ['bun x', BUNX],
]);

// A package that npx or a relative would run, the words that started it, and whether a binary of
// that name in node_modules/.bin is what would run: not for a package option, whose value is a
// package name, nor for a runner that always downloads.
interface PackageRun {
  runner: string;
  name: Word;
  lookup: boolean;
}

// The package runner a program and its arguments start, and the arguments after its words.
const packageRunner = (
  program: string,
  args: Word[],
): { runner: string; wrapper: PackageRunner; args: Word[] } | undefined => {
  const wrapper = PACKAGE_RUNNERS.get(program);
  if (wrapper !== undefined) return { runner: program, wrapper, args };
  const runner = `${program} ${args[0]?.text}`;
  const subcommand = PACKAGE_RUNNERS.get(runner);
  return subcommand && { runner, wrapper: subcommand, args: args.slice(1) };
};

// The words that change directory: bash's and PowerShell's commands and aliases, PowerShell's cd..
// and cd\ functions, and a drive letter, which PowerShell and cmd switch to.
const CHANGE_DIRECTORY =
  /^(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location|cd\.\.|cd\\|[a-z]:)$/i;

// Set-Location's and Push-Location's parameters that take the path, and the one other that takes
// a value.
const LOCATION_PATH = new Set(['path', 'literalpath', 'lp', 'pspath']);
const LOCATION_VALUE = new Set(['stackname']);

// Where a change of directory goes: the path it names, or undefined when that is computed at run
// time or kept by the shell (cd -, ~-, popd, a bare cd, a drive letter's own current directory).
// bash's cd options (-P, -L, -e) and cmd's /d are skipped.
const destination = (command: Word, args: Word[]): Chdir => {
  const name = command.text.toLowerCase();
  if (name === 'cd..') return '..';
  if (name === 'cd\\') return '\\';
  if (!/^(?:cd|chdir|pushd|set-location|sl|push-location)$/.test(name)) return undefined;
  let target: Word | undefined;
  for (let i = 0; i < args.length && target === undefined; i++) {
    const word = args[i] as Word;
    const [, parameter = '', value] = /^-([a-z]+)(?::(.*))?$/is.exec(word.text) ?? [];
    const option = parameter !== '' || word.text === '--' || /^\/d$/i.test(word.text);
    if (word.quoted || !option) target = word;
    else if (LOCATION_PATH.has(parameter.toLowerCase())) {
      target = value === undefined ? args[++i] : { ...word, text: value };
    } else if (LOCATION_VALUE.has(parameter.toLowerCase()) && value === undefined) i++;
  }
  if (target === undefined || target.dynamic || target.text === '' || target.text === '-') {
    return undefined;
  }
  // ~ and ~/… are the home directory; ~-, ~+ and ~user are the shell's to know.
  if (target.text.startsWith('~') && !/^~(?:$|[\\/])/.test(target.text)) return undefined;
  return target.text;
};

// bash's reserved words that can come before a command, and PowerShell's dot operator.
const RESERVED_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '.']);
// A PowerShell assignment operator, as in `$out = git push`.
const ASSIGNMENT = /^[-+*/%?]?=$/;

// Whether the first words are an environment assignment, a reserved word or a PowerShell
// assignment, and how many.
const leadingWords = ([first, second]: Word[]): number => {
  if (first === undefined) return 0;
  if (ENV_ASSIGNMENT.test(first.text) || RESERVED_WORDS.has(first.text)) return 1;
  return first.dynamic && ASSIGNMENT.test(second?.text ?? '') ? 2 : 0;
};

// The option a wrapper's word names, and the value the word holds, as getopt reads it: after `=`;
// a long option or the one long option it is a prefix of (--chd for --chdir); or in a group of
// short options, the first that takes a value takes the rest of the word (-iC../wt is -i, then
// -C with ../wt), or the next word when nothing is left (-iC ../wt).
const getopt = (text: string, withValue: readonly string[]): { option: string; value?: string } => {
  const [name = '', value] = text.split(/=(.*)/s);
  const option = (found: string) =>
    value === undefined ? { option: found } : { option: found, value };
  if (name === '--' || withValue.includes(name)) return option(name);
  if (name.startsWith('--')) {
    const longs = withValue.filter((each) => each.startsWith(name));
    return option(longs.length === 1 ? (longs[0] ?? name) : name);
  }
  for (let j = 1; j < text.length; j++) {
    const short = `-${text[j]}`;
    if (!withValue.includes(short)) continue;
    const rest = text.slice(j + 1);
    return rest === '' ? { option: short } : { option: short, value: rest };
  }
  return { option: name };
};

// The program and arguments of a simple command, after environment assignments, reserved words,
// PowerShell assignments and wrapper words. A wrapper option whose value is a command adds it to
// `nested`; a package a package runner would run goes to `found.packages`, and a change of
// directory sets `found.movesDir`.
const invocation = (words: Word[], nested: string[], found: Findings): Invocation | undefined => {
  let rest = words;
  const chdirs: Chdir[] = [];
  for (;;) {
    for (let skip = leadingWords(rest); skip > 0; skip = leadingWords(rest))
      rest = rest.slice(skip);
    const [first, ...operands] = rest;
    if (first === undefined) return undefined;
    // `cd\` has no last path part, so it is tested before programName drops it.
    const program = first.dynamic ? COMPUTED : programName(first.text);
    const moves = !first.dynamic && CHANGE_DIRECTORY.test(first.text);
    if (moves || CHANGE_DIRECTORY.test(program)) found.movesDir = true;
    const runner = packageRunner(program, operands);
    const wrapper = runner?.wrapper ?? WRAPPERS.get(program);
    if (wrapper === undefined) {
      const moved = moves
        ? first
        : CHANGE_DIRECTORY.test(program)
          ? { ...first, text: program }
          : undefined;
      return { program, args: operands, chdirs, ...(moved === undefined ? {} : { moves: moved }) };
    }
    const args = runner?.args ?? operands;
    const run = (name: Word | undefined, lookup: boolean) => {
      if (runner === undefined || name === undefined) return;
      const always = runner.wrapper.alwaysDownloads === true;
      found.packages.push({ runner: runner.runner, name, lookup: lookup && !always });
    };
    let i = 0;
    while (args[i]?.text.startsWith('-')) {
      const word = args[i] as Word;
      const { option, value } = getopt(word.text, wrapper.withValue);
      if (option === '--') {
        i++;
        break;
      }
      const packageOption = runner?.wrapper.packages.includes(option) === true;
      if (runner?.wrapper.moves?.includes(option)) found.movesDir = true;
      if (wrapper.chdir?.includes(option)) {
        const dir = value === undefined ? args[i + 1] : { ...word, text: value };
        chdirs.push(dir === undefined || dir.dynamic || wrapper.foreign ? undefined : dir.text);
        found.movesDir = true;
      }
      if (value !== undefined) {
        if (packageOption) run({ ...word, text: value }, false);
        i++;
        continue;
      }
      if (!wrapper.withValue.includes(option)) {
        i++;
        continue;
      }
      if (wrapper.runs?.includes(option)) nested.push(args[i + 1]?.text ?? '');
      else if (packageOption) run(args[i + 1], false);
      i += 2;
    }
    run(args[i], true);
    rest = args.slice(i + (wrapper.operands ?? 0));
  }
};

const text = (words: Word[]): string => words.map((word) => word.text).join(' ');

// --force, --force-with-lease[=…], -f alone or in a group such as -uf, or a +refspec.
const isForceArg = (arg: string): boolean =>
  arg.startsWith('--force') || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || arg.startsWith('+');

// --delete, -d alone or in a group, a :branch refspec, or --mirror.
const isDeleteOrMirrorArg = (arg: string): boolean =>
  arg === '--delete' ||
  arg === '--mirror' ||
  /^-[A-Za-z]*d[A-Za-z]*$/.test(arg) ||
  arg.startsWith(':');

// What the gate found in a command and everything nested in it.
interface Findings {
  reasons: string[];
  gated: boolean;
  // Where each push and gh pr create runs, and whether it is a push.
  places: { place: Place; push: boolean }[];
  // The pull requests `gh pr ready` marks ready, each needing its review summary, and where gh
  // runs.
  readies: { target: ReadyTarget; place: Place }[];
  // Whether any command read, decoded and nested ones too, mentions GH_REPO or GH_HOST.
  ghEnv: boolean;
  // The packages npx and its relatives run, each needing to be a binary the lockfile installed.
  packages: PackageRun[];
  // Whether any command read changes directory, so npx may run in another package.
  movesDir: boolean;
  reads: number;
}

// What one reading of a command collects besides findings: more commands to read, and the
// commands that alias definitions would run.
interface Reading {
  found: Findings;
  nested: string[];
  aliases: string[];
  // Where the command being read runs.
  place: Place;
}

// The command a git alias value runs: `!…` runs a shell command, anything else a git command.
const gitAlias = (value: string): string =>
  value.startsWith('!') ? value.slice(1) : `git ${value}`;

const readGit = (args: Word[], literal: boolean, { found, aliases, place }: Reading): void => {
  let i = 0;
  // Each -C is resolved against the ones before it, as git reads them.
  let gitPlace = place;
  while (args[i]?.text.startsWith('-')) {
    const option = args[i]?.text ?? '';
    const value = args[i + 1]?.text ?? '';
    if (option === '-c' && /^alias\..*=/is.test(value)) {
      aliases.push(gitAlias(value.slice(value.indexOf('=') + 1)));
    }
    if (option === '-C') gitPlace = moveTo(gitPlace, args[i + 1]?.dynamic ? undefined : value);
    i += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  const subcommand = args[i];
  if (subcommand?.text === 'push' || (literal && subcommand?.dynamic)) {
    found.gated = true;
    found.places.push({ place: gitPlace, push: true });
    const pushArgs = args.slice(i + 1).map((word) => word.text);
    if (pushArgs.some(isForceArg)) found.reasons.push(FORCE_PUSH_BLOCKED);
    else if (pushArgs.some(isDeleteOrMirrorArg)) found.reasons.push(DELETE_PUSH_BLOCKED);
  } else if (subcommand?.text === 'config') {
    const key = args.findIndex((word, j) => j > i && /^alias\./i.test(word.text));
    const value = key < 0 ? undefined : args[key + 1];
    if (value !== undefined) aliases.push(gitAlias(value.text));
  }
};

// The positional arguments, skipping flags and the values of flags that take one.
const positionals = (args: Word[], optionsWithValue: Set<string>): Word[] => {
  const result: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.text.startsWith('-')) result.push(arg);
    else if (optionsWithValue.has(arg.text)) i++;
  }
  return result;
};

// The value of gh's last short or long option (-R or --repo, -X or --method), given as the next
// word, after `=`, or joined to the short option as gh reads it: the last one wins.
const lastOption = (args: Word[], short: string, long: string): Word | undefined => {
  const joinedOption = new RegExp(`^(?:${short}=?|${long}=)(.+)$`, 's');
  let value: Word | undefined;
  for (const [i, arg] of args.entries()) {
    const joined = joinedOption.exec(arg.text);
    if (arg.text === short || arg.text === long) value = args[i + 1];
    else if (joined !== null) value = { ...arg, text: joined[1] ?? '' };
  }
  return value;
};

// GitHub's GraphQL endpoint as gh api takes it: `graphql`; `/graphql`, which gh joins to the REST
// prefix (api.github.com/graphql); or a full URL, which gh uses as it is, ending in /graphql
// (api.github.com/graphql, <host>/api/graphql on GitHub Enterprise Server), before any query
// string (#314). An endpoint built at run time is taken at its worst when its literal text still
// ends in /graphql ("$base/graphql"), as for the merge endpoint. So is a literal path whose last
// segment is graphql and which has a . or .. segment (x/../graphql): gh joins it to the REST
// prefix without resolving them, and the server may (#329).
const GRAPHQL_ENDPOINT = /^(?:\/?graphql|[a-z][\w+.-]*:\/\/[^?#]*\/graphql)\/?(?:[?#].*)?$/is;
const GRAPHQL_PATH = /\/graphql\/?(?:[?#].*)?$/is;
const DOTTED_GRAPHQL_PATH = /^(?:[^?#]*\/)?\.\.?\/(?:[^?#]*\/)?graphql\/?(?:[?#].*)?$/is;
const isGraphqlEndpoint = (arg: Word): boolean =>
  GRAPHQL_ENDPOINT.test(arg.text) ||
  DOTTED_GRAPHQL_PATH.test(arg.text) ||
  (arg.dynamic && GRAPHQL_PATH.test(arg.text));

// Whether a `gh api graphql` call takes its query from where the gate cannot read it: a file
// (query=@…), its input (--input) or a value computed at run time, also with the field flag
// joined to it (-Fquery=…, --field=query=…).
const unreadableQuery = (args: Word[]): boolean =>
  args.some((arg) => {
    const field = arg.text.replace(/^(?:-[fF]|--(?:raw-)?field=)/, '');
    return (
      arg.text === '--input' ||
      arg.text.startsWith('--input=') ||
      (/^query=/.test(field) && (arg.dynamic || field.startsWith('query=@')))
    );
  });

// The method of a `gh api` call, from its last -X or --method, also after -i in one group of short
// flags (-iX PUT): undefined when none is given, and COMPUTED when it is computed at run time.
const apiMethod = (args: Word[]): string | undefined => {
  const ungrouped = args.map((arg) => ({ ...arg, text: arg.text.replace(/^-i+X/, '-X') }));
  const method = lastOption(ungrouped, '-X', '--method');
  return method?.dynamic ? COMPUTED : method?.text.toUpperCase();
};

// Whether a `gh api` call merges a pull request: a PUT (or a method computed at run time) to a path
// or URL ending in pulls/<n>/merge, before any query string, or a GraphQL query naming the
// mutations that merge one, turn on its auto-merge or add it to the merge queue. A GET of the
// endpoint only asks whether the pull request is merged.
const MERGE_ENDPOINT = /(?:^|\/)pulls\/[^/?#]+\/merge(?:[?#].*)?$/s;
const MERGE_MUTATION = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest)\b/;
const apiMerges = (args: Word[]): boolean => {
  const method = apiMethod(args);
  return (
    args.some((arg) => MERGE_MUTATION.test(arg.text)) ||
    ((method === 'PUT' || method === COMPUTED) && args.some((arg) => MERGE_ENDPOINT.test(arg.text)))
  );
};

// The pull request and repository of `gh pr ready`, unless it is --undo, which always passes.
// Any argument computed at run time, or splatted in PowerShell (@args), may name another
// repository.
const readReady = (args: Word[], pr: Word | undefined, { found, place }: Reading): void => {
  if (args.some((arg) => arg.text === '--undo')) return;
  const repo = lastOption(args, '-R', '--repo');
  if (args.some((arg) => arg.dynamic || /^@\w/.test(arg.text))) {
    found.reasons.push(READY_COMPUTED_BLOCKED);
  } else {
    const target = {
      ...(pr === undefined ? {} : { pr: pr.text }),
      ...(repo === undefined ? {} : { repo: repo.text }),
    };
    found.readies.push({ target, place });
  }
};

const readGh = (args: Word[], literal: boolean, reading: Reading): void => {
  const { found, aliases } = reading;
  const [group, action, name, expansion] = positionals(args, GH_OPTIONS_WITH_VALUE);
  if (group?.text === 'pr' || (literal && group?.dynamic)) {
    if (action?.dynamic || (group?.dynamic && action?.text === 'merge')) {
      found.reasons.push(COMPUTED_PR_ACTION_BLOCKED);
    } else if (action?.text === 'merge') found.reasons.push(PR_MERGE_BLOCKED);
    else if (action?.text === 'create' || action?.text === 'new') {
      found.gated = true;
      found.places.push({ place: reading.place, push: false });
    } else if (action?.text === 'ready') readReady(args, name, reading);
  }
  // A group computed at run time may be pr or api, so it is read as both.
  if (group?.text === 'api' || group?.dynamic) {
    if (args.some((arg) => /markPullRequestReadyForReview/i.test(arg.text))) {
      found.reasons.push(READY_API_BLOCKED);
    } else if (apiMerges(args)) found.reasons.push(PR_MERGE_BLOCKED);
    // Anywhere: gh api's own options (-X POST, -H …) take values that positionals cannot skip.
    else if (args.some(isGraphqlEndpoint) && unreadableQuery(args)) {
      found.reasons.push(UNREADABLE_QUERY_BLOCKED);
    }
  } else if (literal && group?.text === 'alias' && action?.text === 'set' && name && expansion) {
    const shell = args.some((arg) => arg.text === '--shell' || arg.text === '-s');
    const value = expansion.text;
    aliases.push(shell || value.startsWith('!') ? value.replace(/^!/, '') : `gh ${value}`);
  }
};

// Whether an option word tells a delete to recurse. rm takes -r or -R in a group of its short
// options, or --recursive or a prefix of it; PowerShell's Remove-Item and its aliases (rm too)
// take -Recurse or a prefix of it, also as -Recurse:<value> but not -Recurse:$false; cmd's rd and
// del take /s, also among other switches written together (/s/q). GNU and BSD rm's flags may share
// the group, and bash drops quotes around it; PowerShell reads a quoted word as a value, and an en
// dash, em dash or horizontal bar as a parameter's dash.
const POSIX_RECURSIVE = /^-[dfiIvPWxrR]*[rR][dfiIvPWxrR]*$/;
const PARAMETER = new RegExp(
  `^[-${String.fromCodePoint(0x2013, 0x2014, 0x2015)}]([a-z]+)(?::(.*))?$`,
  'is',
);
const recursesPowershell = (word: Word): boolean => {
  const [, name, value] = PARAMETER.exec(word.text) ?? [];
  return (
    !word.quoted &&
    name !== undefined &&
    'recurse'.startsWith(name.toLowerCase()) &&
    value?.toLowerCase() !== '$false'
  );
};
const recursesRm = (word: Word): boolean =>
  POSIX_RECURSIVE.test(word.text) ||
  (word.text.length > 2 && '--recursive'.startsWith(word.text)) ||
  recursesPowershell(word);
const recursesCmd = (word: Word): boolean =>
  /^(?:\/[a-z]+)+$/i.test(word.text) && word.text.toLowerCase().split('/').includes('s');
const REMOVE_ITEM = new Set(['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const CMD_DELETES = new Set(['rd', 'rmdir', 'del', 'erase']);
const isDelete = (word: Word | undefined): boolean =>
  word !== undefined &&
  !word.dynamic &&
  (programName(word.text) === 'rm' || REMOVE_ITEM.has(programName(word.text)));

// A recursive delete whose path holds a variable or a substitution: bash's and PowerShell's $…,
// $( ) and bash's backticks, which the lexer marks as computed, PowerShell's @( ), and cmd's %…%
// (#281). A PowerShell switch given a value (-Recurse:$true) and a redirection (2>$null) are no
// path.
const deletesComputedPath = (program: string, args: Word[]): boolean => {
  const recurses =
    program === 'rm'
      ? recursesRm
      : REMOVE_ITEM.has(program)
        ? (word: Word) =>
            recursesPowershell(word) || (CMD_DELETES.has(program) && recursesCmd(word))
        : undefined;
  if (recurses === undefined || !args.some(recurses)) return false;
  return args.some((word) => {
    const switchValue = /^\$(?:true|false)$/i.test(PARAMETER.exec(word.text)?.[2] ?? '');
    const redirection = /^\d?>/.test(word.text);
    if (switchValue || redirection) return false;
    return word.dynamic || word.text.startsWith('@(') || /%[^%\s]+%/.test(word.text);
  });
};

// The commands pwsh or powershell runs: the rest of the line after -Command (or any prefix of
// it, such as -c), a decoded -EncodedCommand, and each other operand, since Windows PowerShell
// reads its first operand as a command.
const powershellCommands = (args: Word[]): string[] => {
  const commands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? { text: '', dynamic: false, quoted: false };
    const name = !arg.quoted && arg.text.startsWith('-') ? arg.text.slice(1).toLowerCase() : '';
    if (name === '') {
      commands.push(arg.text);
    } else if ('command'.startsWith(name)) {
      commands.push(text(args.slice(i + 1)));
      break;
    } else if ('encodedcommand'.startsWith(name) || name === 'ec') {
      commands.push(Buffer.from(args[i + 1]?.text ?? '', 'base64').toString('utf16le'));
      i++;
    }
  }
  return commands;
};

// The command cmd runs after /c or /k (//c in Git Bash, which would turn /c into a path), without
// its ^ escapes.
const cmdCommands = (args: Word[]): string[] => {
  const run = args.findIndex((arg) => /^\/\/?[ck]$/i.test(arg.text));
  return run < 0 ? [] : [text(args.slice(run + 1)).replaceAll('^', '')];
};

// Start-Process parameters that take a value, with their aliases; the first match of a prefix
// wins, as -f does for -FilePath.
const START_PROCESS_PARAMETERS: [name: string, role: 'file' | 'args' | 'other'][] = [
  ['filepath', 'file'],
  ['path', 'file'],
  ['pspath', 'file'],
  ['argumentlist', 'args'],
  ['args', 'args'],
  ['workingdirectory', 'other'],
  ['verb', 'other'],
  ['windowstyle', 'other'],
  ['redirectstandardinput', 'other'],
  ['redirectstandardoutput', 'other'],
  ['redirectstandarderror', 'other'],
  ['credential', 'other'],
  ['environment', 'other'],
];

// The command Start-Process starts, from -FilePath and -ArgumentList or its two positional
// parameters, and the plain reading of its arguments as a command (cmd's `start git push`).
const startProcessCommands = (args: Word[]): string[] => {
  const file: string[] = [];
  const list: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? { text: '', dynamic: false, quoted: false };
    if (arg.quoted || !arg.text.startsWith('-')) {
      operands.push(arg.text);
      continue;
    }
    const colon = arg.text.indexOf(':');
    const name = arg.text.slice(1, colon < 0 ? undefined : colon).toLowerCase();
    const role = START_PROCESS_PARAMETERS.find(([parameter]) => parameter.startsWith(name))?.[1];
    if (name === '' || role === undefined) continue;
    const value = colon < 0 ? (args[++i]?.text ?? '') : arg.text.slice(colon + 1);
    if (role === 'file') file.push(value);
    else if (role === 'args') list.push(value);
  }
  if (file.length === 0) file.push(operands.shift() ?? '');
  if (list.length === 0) list.push(operands.shift() ?? '');
  // The file stays one word, quoted, so a path with a space keeps its program name.
  const program = `"${file.join(' ')}"`;
  const words = list.join(' ').split(/[\s,]+/);
  return [
    [program, ...words.map((word) => word.replace(/^[@('"]+|['")]+$/g, ''))].join(' '),
    text(args),
  ];
};

// Interpreters and their options whose value is code, such as node -e.
const INTERPRETERS = new Map<string, readonly string[]>([
  ['node', ['-e', '--eval', '-p', '--print']],
  ['bun', ['-e', '--eval', '-p', '--print']],
  ['python', ['-c']],
  ['python3', ['-c']],
  ['py', ['-c']],
  ['perl', ['-e', '-E']],
  ['ruby', ['-e']],
]);

// A command line without its quotes and brackets, so a command inside another language's string
// or list (execSync('git push -f'), ['git', 'push']) or after a stray quote reads as one.
const withoutQuotes = (text: string): string => text.replace(/["'`$@[\],]/g, ' ');

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
const EVALUATORS = new Set(['eval', 'iex', 'invoke-expression', '[scriptblock]::create']);
const START_PROCESS = new Set(['start-process', 'start', 'saps']);
// Reads one simple command; returns whether it runs code given as text, so that every string
// and every argument list of the command line may be code.
const readInvocation = ({ program, args }: Invocation, reading: Reading): boolean => {
  if (program === 'git' || program === COMPUTED) readGit(args, program === 'git', reading);
  if (program === 'gh' || program === COMPUTED) readGh(args, program === 'gh', reading);
  if (deletesComputedPath(program, args)) reading.found.reasons.push(VARIABLE_DELETE_BLOCKED);
  const { nested } = reading;
  const codeOptions = INTERPRETERS.get(program);
  if (codeOptions !== undefined) {
    if (args.some((arg) => codeOptions.includes(arg.text))) nested.push(withoutQuotes(text(args)));
    return false;
  }
  if (POSIX_SHELLS.has(program)) {
    nested.push(...args.filter((arg) => !/^[-+]/.test(arg.text)).map((arg) => arg.text));
  } else if (POWERSHELLS.has(program)) nested.push(...powershellCommands(args));
  else if (program === 'cmd') nested.push(...cmdCommands(args));
  else if (EVALUATORS.has(program)) nested.push(text(args));
  else if (START_PROCESS.has(program)) nested.push(...startProcessCommands(args));
  // A program computed at run time may be a shell too.
  else return program === COMPUTED;
  return true;
};

// Reads a command that runs at `base`. A command nested in one that changes directory may run
// anywhere, so its place is computed.
const read = (
  command: string,
  depth: number,
  found: Findings,
  dialects: readonly Dialect[],
  base: Place,
): void => {
  found.reads++;
  if (/GH_REPO|GH_HOST/i.test(normalised(command))) found.ghEnv = true;
  if (depth > MAX_DEPTH || found.reads > MAX_READS) {
    found.reasons.push(TOO_DEEP_BLOCKED);
    return;
  }
  const nested = new Set<string>();
  const aliases = new Set<string>();
  const unquoted = new Set<string>();
  let moved = false;
  for (const dialect of dialects) {
    const lexed = lex(command, dialect);
    const reading: Reading = { found, nested: [...lexed.substitutions], aliases: [], place: base };
    // A change of directory lasts for the rest of the command.
    let place = base;
    let runsText = false;
    for (const words of lexed.segments) {
      const called = invocation(words, reading.nested, found);
      if (called === undefined) continue;
      if (called.moves !== undefined) place = moveTo(place, destination(called.moves, called.args));
      moved ||= called.moves !== undefined || called.chdirs.length > 0;
      reading.place = called.chdirs.reduce(moveTo, place);
      if (readInvocation(called, reading)) runsText = true;
    }
    if (runsText) {
      // Without the options before them (-c, and cmd's /c), so that the cd of bash -c or cmd /c
      // counts where the push runs.
      const option = (word: Word) => word.text.startsWith('-') || /^\/[a-z?]$/i.test(word.text);
      const operands = lexed.segments.map((words) => {
        const start = words.findIndex((word, i) => i > 0 && !option(word));
        return start < 0 ? '' : text(words.slice(start));
      });
      reading.nested.push(...lexed.strings, ...operands);
    }
    // A string over several lines may be an apostrophe in a comment, a heredoc or a here-string
    // read as a quote, so its lines are read as commands too.
    reading.nested.push(...lexed.strings.filter((string) => /[\r\n]/.test(string)));
    // Read without quotes, so a stray quote never hides what follows it. It is this command, its
    // changes of directory included, so it runs where this command does.
    if (lexed.unclosed) unquoted.add(withoutQuotes(command));
    for (const each of reading.nested) nested.add(each);
    for (const each of reading.aliases) aliases.add(each);
  }
  for (const each of nested) {
    if (each.trim() !== '') read(each, depth + 1, found, DIALECTS, moved ? undefined : base);
  }
  for (const each of unquoted) read(each, depth + 1, found, DIALECTS, base);
  for (const alias of aliases) {
    const defined = noFindings(found.reads);
    read(alias, depth + 1, defined, DIALECTS, []);
    found.reads = defined.reads;
    if (defined.gated || defined.readies.length > 0 || defined.reasons.length > 0) {
      found.reasons.push(ALIAS_BLOCKED);
    }
  }
};

const noFindings = (reads: number): Findings => ({
  reasons: [],
  gated: false,
  places: [],
  readies: [],
  ghEnv: false,
  packages: [],
  movesDir: false,
  reads,
});

const findings = (command: string, dialects: readonly Dialect[] = DIALECTS): Findings => {
  const found = noFindings(0);
  read(command, 0, found, dialects, []);
  return found;
};

// node:path's posix or win32 functions; a type, so the module still has no static imports.
export type PathModule = typeof import('node:path').posix;

// The directory a command runs in: the hook's working directory, then each directory it changes
// into, in order, with Git Bash's /c/… drive paths on Windows and a home path (~, ~/…) expanded.
export const resolvePlace = (
  cwd: string,
  dirs: readonly string[],
  path: PathModule,
  home: string,
): string => {
  if (dirs.length === 0) return cwd;
  const windows = path.sep === '\\';
  const expand = (dir: string): string => {
    if (/^~(?:$|[\\/])/.test(dir)) return path.join(home, dir.slice(1));
    const drive = windows ? /^\/([a-z])(?=\/|$)/i.exec(dir) : null;
    return drive === null ? dir : `${drive[1]?.toUpperCase()}:\\${dir.slice(2)}`;
  };
  return path.resolve(cwd, ...dirs.map(expand));
};

// Whether `dir` is inside the project at `root` (CLAUDE_PROJECT_DIR) by real path, and not in a
// review's scratch folder under .foedrum/tmp/. On Windows a network, device or drive-less path,
// or one on another drive, is refused before anything resolves it.
export const projectHolds = async (
  root: string | undefined,
  dir: string,
  platform: NodeJS.Platform,
  realPath: (path: string) => string,
): Promise<boolean> => {
  const [{ posix, win32 }, { windowsDrive, windowsPathProblem }, { pathInside, samePath }] =
    await Promise.all([
      import('node:path'),
      import('../src/platform/real-path.ts'),
      import('../src/platform/paths.ts'),
    ]);
  const path = platform === 'win32' ? win32 : posix;
  if (root === undefined || !path.isAbsolute(root)) return false;
  if (platform === 'win32') {
    if (windowsPathProblem(dir) !== undefined) return false;
    if (windowsDrive(dir) !== windowsDrive(root)) return false;
  }
  try {
    const [project, real] = [realPath(root), realPath(dir)];
    if (samePath(project, real, platform)) return true;
    const inside = pathInside(project, real, platform);
    return inside !== undefined && !/(?:^|\/)\.foedrum\/tmp(?:\/|$)/i.test(inside);
  } catch {
    return false;
  }
};

export const isGatedCommand = (command: string): boolean => findings(command).gated;

export const forbiddenReason = (command: string): string | undefined =>
  findings(command).reasons[0];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const lastChars = (text: string): string =>
  text.length > MAX_OUTPUT_CHARS ? `…\n${text.slice(-MAX_OUTPUT_CHARS)}` : text;

// Why node_modules in the checkout around `cwd` is out of date, or undefined.
export type StaleReason = (cwd: string) => Promise<string | undefined>;

// Whether HEAD in the checkout around `cwd` is detached; rejects when it cannot tell.
export type HeadIsDetached = (cwd: string) => Promise<boolean>;

// Whether the package around `cwd` has `node_modules/.bin/<name>`, a binary the lockfile installed.
export type BinaryInstalled = (cwd: string, name: string) => Promise<boolean>;

// Why a push from `dir` would send a word on the personal denylist, or undefined (ADR 0114);
// rejects when it cannot tell.
export type DeniedPush = (dir: string) => Promise<string | undefined>;

// Whether a directory a command changes into is inside the project the session works in
// (CLAUDE_PROJECT_DIR), so the gate may run that tree's code.
export type InProject = (dir: string) => Promise<boolean>;

// The pull request `gh pr ready` names: its number, URL or branch (none for the current branch's),
// and the repository given with -R.
export interface ReadyTarget {
  pr?: string;
  repo?: string;
}

// What the gate needs to know of a pull request: its head, its comments, oldest first, and its
// commits (those on its branch that are not on the base) with their parents, and the paths of the
// files it changes, left out when gh could not list them all.
export interface PullRequestFacts {
  number: number;
  head: string;
  comments: string[];
  commits: { sha: string; parents: string[] }[];
  files?: string[];
}

// Reads the pull request from GitHub, run in the checkout around `cwd`; rejects when it cannot.
export type LookupPullRequest = (cwd: string, target: ReadyTarget) => Promise<PullRequestFacts>;

// The heading of a /brew-review summary comment (summary-template.md) and the head it reviewed.
const SUMMARY_HEADING = /^## Review: `[^`\n]*` @ `([0-9a-f]{7,40})`/gm;

// Whether a review of `reviewed` still covers the pull request: it is the head, or every commit
// of the branch that is not part of it is a merge. A merge of the base brings in only commits
// that are on the base, so they are not among the branch's (#146); a commit of the branch's own
// after the review is not a merge, and fails.
const covers = ({ head, commits }: PullRequestFacts, reviewed: string): boolean => {
  if (head.startsWith(reviewed)) return true;
  // A list that leaves out the head (GitHub lists at most 250) cannot show what came after.
  if (!commits.some((commit) => commit.sha === head)) return false;
  const start = commits.find((commit) => commit.sha.startsWith(reviewed));
  if (start === undefined) return false;
  const parents = new Map(commits.map((commit) => [commit.sha, commit.parents]));
  const before = new Set<string>();
  const queue = [start.sha];
  for (const sha of queue) {
    if (before.has(sha)) continue;
    before.add(sha);
    queue.push(...(parents.get(sha) ?? []).filter((parent) => parents.has(parent)));
  }
  return commits.every((commit) => before.has(commit.sha) || commit.parents.length > 1);
};

// Plain documentation, which needs no review summary (#183): Markdown in a subfolder of docs/,
// except the ADRs, which record decisions. The top-level docs are the design and the review's
// criteria, so they are reviewed. Only a full file list counts.
const onlyPlainDocs = (files: string[] | undefined): boolean =>
  files !== undefined &&
  files.length > 0 &&
  files.every((path) => /^docs\/(?!adr\/)[^/]+\/.*\.md$/i.test(path));

// Why `gh pr ready` may not mark the pull request ready, or undefined when its review summary
// covers the head or it changes only plain documentation.
const readyRefusal = async (
  cwd: string,
  target: ReadyTarget,
  lookupPullRequest: LookupPullRequest,
): Promise<string | undefined> => {
  let pullRequest: PullRequestFacts;
  try {
    pullRequest = await lookupPullRequest(cwd, target);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const which = target.pr ?? 'of the current branch';
    return `gh pr ready is blocked: could not read pull request ${which} to find its review summary (${why}).`;
  }
  const { number, head, comments, files } = pullRequest;
  if (onlyPlainDocs(files)) return undefined;
  const reviewed = comments.flatMap((body) =>
    [...body.matchAll(SUMMARY_HEADING)].map((match) => match[1] ?? ''),
  );
  if (reviewed.some((sha) => covers(pullRequest, sha))) return undefined;
  const newest = reviewed.at(-1);
  if (newest === undefined) {
    return `gh pr ready is blocked: pull request #${number} has no /brew-review summary (a comment headed "## Review: \`<branch>\` @ \`<head>\`"). Run /brew-review ${number} and post its summary first; the review is part of the procedure, not a step to get past (CLAUDE.md).`;
  }
  return `gh pr ready is blocked: the newest /brew-review summary on pull request #${number} is for ${newest.slice(0, 7)}, but the head is ${head.slice(0, 7)}, and commits other than merges came after it. Run /brew-review ${number} for the head and post its summary first.`;
};

export const precheck = async (
  input: string,
  runCheck: RunCheck,
  staleReason: StaleReason = async () => undefined,
  headIsDetached: HeadIsDetached = async () => false,
  lookupPullRequest: LookupPullRequest = async () => {
    throw new Error('no pull request lookup');
  },
  binaryInstalled: BinaryInstalled = async () => false,
  inProject: InProject = async () => true,
  deniedPush: DeniedPush = async () => undefined,
): Promise<HookResult> => {
  if (!mayNeedTheGate(input)) return { exitCode: 0, stderr: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
  } catch {
    return { exitCode: 2, stderr: 'precheck: could not parse the hook input as JSON.\n' };
  }
  if (!isRecord(parsed)) {
    return { exitCode: 2, stderr: 'precheck: the hook input is not a JSON object.\n' };
  }

  const command = isRecord(parsed.tool_input) ? parsed.tool_input.command : undefined;
  if (typeof command !== 'string') return { exitCode: 0, stderr: '' };
  // The input test above only skips parsing; the command decides, so a cwd, transcript path or
  // description that spells git does not send the call to the parser (#152).
  if (!mayNeedTheGate(command)) return { exitCode: 0, stderr: '' };
  const found = findings(command, TOOL_DIALECTS.get(parsed.tool_name));
  const [reason] = found.reasons;
  if (reason !== undefined) return { exitCode: 2, stderr: `${reason}\n` };
  const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : process.cwd();
  for (const { runner, name, lookup } of found.packages) {
    // Only a plain name is looked up: a version, a scope, a path, a computed name or one Windows
    // maps to a device is not what node_modules/.bin holds.
    if (
      !lookup ||
      name.dynamic ||
      !BINARY_NAME.test(name.text) ||
      WINDOWS_DEVICE.test(name.text) ||
      !(await binaryInstalled(cwd, name.text))
    ) {
      return { exitCode: 2, stderr: `${downloadBlocked(`${runner} ${name.text}`)}\n` };
    }
  }
  const [run] = found.packages;
  if (run !== undefined && found.movesDir) {
    return { exitCode: 2, stderr: `${movedRunBlocked(`${run.runner} ${run.name.text}`)}\n` };
  }
  // Each reading of a command that runs another finds the same pull request again.
  const readies = new Map(found.readies.map((ready) => [JSON.stringify(ready), ready]));
  if (!found.gated && readies.size === 0) return { exitCode: 0, stderr: '' };
  if (readies.size > 0 && found.gated)
    return { exitCode: 2, stderr: `${READY_COMBINED_BLOCKED}\n` };
  // gh reads the repository from them, and the gate's lookup would not.
  if (readies.size > 0 && found.ghEnv) {
    return { exitCode: 2, stderr: `${READY_GH_REPO_BLOCKED}\n` };
  }
  // Where gh and the check run: the directory the command changes into, if any (#132). The gate
  // runs that tree's code (npm run check, git, gh) before the command is approved, so a
  // directory outside the project blocks the command instead.
  const dirOf = async (dirs: readonly string[], what: string): Promise<string | HookResult> => {
    if (dirs.length === 0) return cwd;
    const [path, { homedir }] = await Promise.all([import('node:path'), import('node:os')]);
    const dir = resolvePlace(cwd, dirs, path, homedir());
    if (await inProject(dir)) return dir;
    return { exitCode: 2, stderr: `${outsideBlocked(what, dir)}\n` };
  };

  // Without a number, gh marks the pull request of the branch where it runs; with one, the
  // place only picks the repository, as it does in the hook's working directory.
  if ([...readies.values()].some(({ target, place }) => place === undefined && !target.pr)) {
    return { exitCode: 2, stderr: `${READY_PLACE_BLOCKED}\n` };
  }
  for (const { target, place } of readies.values()) {
    const dir = await dirOf(place ?? [], 'gh pr ready');
    if (typeof dir !== 'string') return dir;
    const refusal = await readyRefusal(dir, target, lookupPullRequest);
    if (refusal !== undefined) return { exitCode: 2, stderr: `${refusal}\n` };
  }
  if (!found.gated) return { exitCode: 0, stderr: '' };
  const computed = found.places.find(({ place }) => place === undefined);
  if (computed !== undefined) {
    const blocked = computed.push ? PUSH_PLACE_BLOCKED : CREATE_PLACE_BLOCKED;
    return { exitCode: 2, stderr: `${blocked}\n` };
  }
  // Each directory, and whether a push runs there.
  const trees = new Map<string, boolean>();
  for (const { place, push } of found.places) {
    const dir = await dirOf(place ?? [], push ? 'git push' : 'gh pr create');
    if (typeof dir !== 'string') return dir;
    trees.set(dir, push || trees.get(dir) === true);
  }
  if (trees.size > 1) {
    return { exitCode: 2, stderr: `${manyPlacesBlocked([...trees.keys()])}\n` };
  }
  const [dir = cwd, pushes = false] = [...trees][0] ?? [];
  // A session pushes a branch; commits made on a detached HEAD are on none (#80).
  if (pushes) {
    let detached: boolean;
    try {
      detached = await headIsDetached(dir);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 2,
        stderr: `git push is blocked: could not tell whether HEAD is detached in ${dir} (${why}).\n`,
      };
    }
    if (detached) {
      return {
        exitCode: 2,
        stderr: `git push is blocked: HEAD is detached in ${dir}, so new commits are on no branch; switch to your branch, move it to those commits, and push again.\n`,
      };
    }
    // What the push sends, against the personal denylist (ADR 0114); without one, nothing runs.
    let denied: string | undefined;
    try {
      denied = await deniedPush(dir);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      denied = `git push is blocked: could not check it against your denylist (${why}) (ADR 0114).`;
    }
    if (denied !== undefined) return { exitCode: 2, stderr: `${denied}\n` };
  }
  // A stale tree fails the check deep in an import; say why in one line instead.
  const stale = await staleReason(dir);
  if (stale !== undefined) {
    return {
      exitCode: 2,
      stderr: `node_modules is out of date with package-lock.json (${stale}); run npm ci\n`,
    };
  }
  const { ok, output } = await runCheck(dir);
  if (ok) return { exitCode: 0, stderr: '' };
  return {
    exitCode: 2,
    stderr: `npm run check failed, so this command was blocked. Fix the failures and try again.\n\n${lastChars(output.trim())}\n`,
  };
};

// Type-only, so erased: the module still has no static imports.
import type { NpmCliLookup } from '../src/platform/executables.ts';
import type { ProcessOutcome, RunProcess } from './process-runner.ts';

export type { ProcessOutcome, RunProcess } from './process-runner.ts';

// The check's deadline: after its steps' own (300 s), so a hanging step is named there, and
// before the hook's 600 s, which would end this process without killing the check.
const CHECK_TIMEOUT_MS = 540_000;

// The HEAD check's deadline: a local, read-only git call that should answer at once (#42).
const HEAD_CHECK_TIMEOUT_MS = 10_000;

// Finds npm's CLI script next to the node at the given path (findNpmCli in the platform module).
export type FindNpmCli = (execPath: string) => Promise<NpmCliLookup>;

// `npm run check` through npm's own CLI script, found next to this node, run by this node, so
// the check starts without a shell. Outside Windows the check leads a process group of its own,
// which a Ctrl+C on the push does not reach: `stop` kills its tree.
export const npmCheck =
  (
    execPath: string,
    findNpmCli: FindNpmCli,
    runProcess: RunProcess,
    stop?: AbortSignal,
  ): RunCheck =>
  async (cwd) => {
    const { path: npmCli, tried } = await findNpmCli(execPath);
    if (npmCli === undefined) {
      return {
        ok: false,
        output: `npm's CLI was not found next to node (${execPath}), so the check cannot run. Tried:\n${tried.map((path) => `  ${path}\n`).join('')}Install npm with this node, or run npm run check yourself.`,
      };
    }
    const { exitCode, output, killed } = await runProcess(execPath, [npmCli, 'run', 'check'], cwd, {
      timeoutMs: CHECK_TIMEOUT_MS,
      signal: stop,
    });
    const { whyKilled } = await import('../src/platform/processes.ts');
    const why = whyKilled(killed, CHECK_TIMEOUT_MS);
    if (why === undefined) return { ok: exitCode === 0, output };
    const what = killed === 'stopped' ? 'npm run check was stopped' : `npm run check ${why}`;
    return { ok: false, output: `${output.trimEnd()}\n${what}` };
  };

// `git symbolic-ref -q HEAD` exits 1, silently, only when HEAD is detached. It exits 0 on a branch
// and 128 outside a repository, where git push fails by itself.
export const isDetached = ({ exitCode }: ProcessOutcome): boolean => exitCode === 1;

// Rejects, saying why, when git was killed: at the deadline, when stopped, or at the output limit.
export const gitHeadIsDetached =
  (runProcess: RunProcess): HeadIsDetached =>
  async (cwd) => {
    const outcome = await runProcess('git', ['symbolic-ref', '-q', 'HEAD'], cwd, {
      timeoutMs: HEAD_CHECK_TIMEOUT_MS,
    });
    if (outcome.killed !== undefined) {
      const { whyKilled } = await import('../src/platform/processes.ts');
      const why = whyKilled(outcome.killed, HEAD_CHECK_TIMEOUT_MS);
      throw new Error(
        `git symbolic-ref -q HEAD ${outcome.killed === 'stopped' ? 'was stopped' : why}`,
      );
    }
    return isDetached(outcome);
  };

// The deadline of each gh call: GitHub answers in about a second, and a hung call must not hold
// the gate until the hook's own limit.
const GH_TIMEOUT_MS = 30_000;

// gh's output; rejects, saying why, when gh failed or was killed.
const runGh = async (
  runProcess: RunProcess,
  args: string[],
  cwd: string,
  what: string,
): Promise<string> => {
  const { exitCode, output, killed } = await runProcess('gh', args, cwd, {
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (killed !== undefined) {
    const { whyKilled } = await import('../src/platform/processes.ts');
    throw new Error(
      `${what} ${killed === 'stopped' ? 'was stopped' : whyKilled(killed, GH_TIMEOUT_MS)}`,
    );
  }
  if (exitCode !== 0) {
    const how = exitCode === null ? 'could not start' : `exited ${exitCode}`;
    // One short line: gh's output may be pages of commits or a proxy's error page.
    throw new Error(`${what} ${how}: ${output.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  return output;
};

// The pull request through gh, as gh pr ready would find it: `gh pr view` for its head and
// comments, then its commits with their parents from the REST API, which `gh pr view` leaves out.
export const ghPullRequest =
  (runProcess: RunProcess): LookupPullRequest =>
  async (cwd, { pr, repo }) => {
    const view = await runGh(
      runProcess,
      [
        'pr',
        'view',
        ...(pr === undefined ? [] : [pr]),
        ...(repo === undefined ? [] : ['--repo', repo]),
        '--json',
        'number,url,headRefOid,comments,files,changedFiles',
      ],
      cwd,
      'gh pr view',
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(view);
    } catch {
      throw new Error(`gh pr view did not answer with JSON: ${view.trim().slice(0, 200)}`);
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.number !== 'number' ||
      typeof parsed.url !== 'string' ||
      typeof parsed.headRefOid !== 'string' ||
      !Array.isArray(parsed.comments)
    ) {
      throw new Error('gh pr view answered without number, url, headRefOid and comments');
    }
    const { number, url, headRefOid } = parsed;
    const { host, pathname } = new URL(url);
    const [owner, name] = pathname.split('/').filter((part) => part !== '');
    const commits = await runGh(
      runProcess,
      [
        'api',
        '--hostname',
        host,
        '--paginate',
        `repos/${owner}/${name}/pulls/${number}/commits?per_page=100`,
        '--jq',
        '.[] | [.sha, .parents[].sha] | join(" ")',
      ],
      cwd,
      'gh api',
    );
    // gh lists at most 100 files; a shorter list than the count, or one it cannot read, is left out.
    const listing: unknown[] = Array.isArray(parsed.files) ? parsed.files : [];
    // A renamed or copied file is listed by its new path only, so a reviewed file moved into docs/
    // would look like plain docs: only an added, modified or deleted file counts as read.
    const files = listing.flatMap((file) =>
      isRecord(file) &&
      typeof file.path === 'string' &&
      ['ADDED', 'MODIFIED', 'DELETED'].includes(String(file.changeType))
        ? [file.path]
        : [],
    );
    const listed = files.length === listing.length && files.length === parsed.changedFiles;
    return {
      number,
      head: headRefOid,
      ...(listed ? { files } : {}),
      comments: parsed.comments.map((comment: unknown) =>
        isRecord(comment) && typeof comment.body === 'string' ? comment.body : '',
      ),
      commits: commits
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [sha = '', ...parents] = line.trim().split(/\s+/);
          return { sha, parents };
        }),
    };
  };

// Whether `node_modules/.bin/<name>` exists in the package around `cwd`: the nearest folder up
// with a package.json, where npx looks before it downloads.
export const lockfileBinary =
  (
    read: (path: string) => Promise<string | undefined>,
    exists: (path: string) => Promise<boolean>,
  ): BinaryInstalled =>
  async (cwd, name) => {
    const { packageRoot } = await import('./deps-sync.ts');
    const root = await packageRoot(cwd, read);
    if (root === undefined) return false;
    const { join } = await import('node:path');
    return exists(join(root, 'node_modules', '.bin', name));
  };

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

// Each module below loads only when a gated command needs it, so a call that does not name git
// or gh starts nothing but this file (#41).
if (import.meta.main) {
  const spawnProcess: RunProcess = async (file, args, cwd, options) =>
    (await import('./process-runner.ts')).spawnProcess(file, args, cwd, options);
  const findNpmCli: FindNpmCli = async (execPath) =>
    (await import('../src/platform/executables.ts')).findNpmCli(execPath);
  const runCheck: RunCheck = async (cwd) => {
    const { stopOnSignals } = await import('../src/platform/processes.ts');
    return npmCheck(process.execPath, findNpmCli, spawnProcess, stopOnSignals())(cwd);
  };
  const staleReason = async (cwd: string) => {
    const { outOfDate } = await import('./deps-sync.ts');
    return (await outOfDate(cwd))?.reason;
  };
  const { exitCode, stderr } = await precheck(
    await readStdin(),
    runCheck,
    staleReason,
    gitHeadIsDetached(spawnProcess),
    ghPullRequest(spawnProcess),
    async (cwd, name) => {
      const { access, readFile } = await import('node:fs/promises');
      const read = (path: string) => readFile(path, 'utf8').catch(() => undefined);
      const exists = (path: string) =>
        access(path).then(
          () => true,
          () => false,
        );
      return lockfileBinary(read, exists)(cwd, name);
    },
    // Inside CLAUDE_PROJECT_DIR by real path, as the read guard tells (ADR 0049); without it the
    // gate cannot tell, and fails closed.
    async (dir) => {
      const { realPath } = await import('../src/platform/real-path.ts');
      return projectHolds(process.env.CLAUDE_PROJECT_DIR, dir, process.platform, (path) =>
        realPath(path),
      );
    },
    // The personal denylist, FOEDRUM_DENYLIST or ~/.config/foedrum/denylist.txt (ADR 0114).
    async (dir) => {
      const [{ pushRefusal }, { readDenylist }, { homedir }, { readFileSync }] = await Promise.all([
        import('./denylist.ts'),
        import('../src/platform/denylist.ts'),
        import('node:os'),
        import('node:fs'),
      ]);
      const readList = () =>
        readDenylist(process.env, homedir(), (path) => readFileSync(path, 'utf8'));
      return pushRefusal(readList, spawnProcess)(dir);
    },
  );
  if (stderr !== '') process.stderr.write(stderr);
  process.exitCode = exitCode;
}
