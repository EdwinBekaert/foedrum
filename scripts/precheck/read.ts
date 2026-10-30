// The local gate's reader (ADR 0045, ADR 0252): the shell-word lexer, and the reader that finds
// each git push, gh and npx call in a command, what it runs in turn and where it runs, with the
// refusal lines of the rules it applies as it reads. Pure: core.ts decides on what it found.

import type { GhText } from '../denylist/core.ts';
import { foldQuotes, normalised } from './prefilter.ts';

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
]);
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
const CONFIGURED_PUSH_BLOCKED =
  "git push is blocked in a command that sets git's configuration (-c or --config-env with remote.*, push.*, include.* or includeIf.*, a GIT_CONFIG variable, git config or git remote): it can make the push delete, force or mirror remote refs, and the gate reads git's configuration before the command runs; run that setting or command in a command of its own, and git push without it (ADR 0246).";
const PR_MERGE_BLOCKED =
  '`gh pr merge` is blocked: pull requests are merged by a maintainer, never from a Claude Code session.';
const COMPUTED_PR_ACTION_BLOCKED =
  '`gh pr` with an action computed at run time is blocked: the gate cannot tell it from `gh pr merge`.';
const READY_COMPUTED_BLOCKED =
  'gh pr ready with a pull request or repository computed at run time is blocked: give them as they are, so the gate can find the review summary.';
const TOO_DEEP_BLOCKED =
  'This command nests shells or commands too deeply for the gate to check: run git push and gh pr ready as plain commands.';
const VARIABLE_DELETE_BLOCKED =
  'A recursive delete of a path built from a variable or a substitution is blocked: an empty or wrong value removes the wrong tree; write the literal path, such as `rm -rf .foedrum/tmp/218/run` (CLAUDE.md).';

// A shell's reading of a command line. Git Bash runs the Bash tool's commands, so a tool's command
// is read in its own shell; what it runs in turn may be either, so that is read both ways.
type Dialect = 'bash' | 'powershell';
const DIALECTS: readonly Dialect[] = ['bash', 'powershell'];
export const TOOL_DIALECTS = new Map<unknown, readonly Dialect[]>([
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
  // When PowerShell turns an escape in it (`n, `t, `u{…}, …) into another character, which the
  // lexer keeps as the letter after the backtick.
  escaped?: boolean;
}

// The letters PowerShell reads as an escape after a backtick, rather than as themselves.
const POWERSHELL_ESCAPES = /^[0abefnrtuv]$/;
// PowerShell's pipeline object, with any properties read from it.
const PIPELINE_OBJECT = /^\$(?:_|psitem)(?:\.\w+)*$/i;

interface Lexed {
  // The simple commands, split at ; & | ( ) { } and line breaks outside quotes.
  segments: Word[][];
  // For each segment, the words of the earlier stages of the PowerShell pipeline it is a stage
  // of, which it reads as input; none outside a pipeline.
  inputs: Word[][];
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
  const lexed: Lexed = {
    segments: [],
    inputs: [],
    strings: [],
    substitutions: [],
    unclosed: false,
  };
  let segment: Word[] = [];
  let word: Word | undefined;
  // The words of the PowerShell statement so far, whether a pipe came in it and how many words
  // came before the first, whether that pipe has no stage after it yet, and whether a line break
  // ended the statement, unless the next line starts with a pipe.
  let statement: Word[] = [];
  let piped = false;
  let firstStage = 0;
  let pipeOpen = false;
  let lineEnded = false;
  const add = (text: string, dynamic = false, quoted = false): Word => {
    word ??= { text: '', dynamic: false, quoted };
    word.text += text;
    word.dynamic ||= dynamic;
    return word;
  };
  const markEscape = (escaping: Word, next: string) => {
    if (dialect === 'powershell' && POWERSHELL_ESCAPES.test(next)) escaping.escaped = true;
  };
  const endWord = () => {
    if (word !== undefined) segment.push(word);
    word = undefined;
  };
  const endSegment = () => {
    endWord();
    if (segment.length > 0) {
      if (lineEnded) {
        statement = [];
        piped = false;
        lineEnded = false;
      }
      lexed.segments.push(segment);
      // $_ and $PSItem after the first stage are the pipeline's own object, not another source.
      const sources = statement.filter((w, k) => k < firstStage || !PIPELINE_OBJECT.test(w.text));
      lexed.inputs.push(piped ? sources : []);
      statement.push(...segment);
      pipeOpen = false;
    }
    segment = [];
  };
  const pipelineAt = (char: string, i: number) => {
    const doubled = '&|'.includes(char) && (command[i + 1] === char || command[i - 1] === char);
    if (char === '|' && !doubled) {
      if (!piped) firstStage = statement.length;
      piped = true;
      pipeOpen = true;
      lineEnded = false;
    } else if (char === '\n' || char === '\r') {
      lineEnded ||= !pipeOpen;
    } else if (char === ';' || doubled || (char === '{' && !piped)) {
      statement = [];
      piped = false;
      pipeOpen = false;
      lineEnded = false;
    }
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
      } else if (
        char === '\\' &&
        dialect === 'bash' &&
        (next === '\n' || (next === '\r' && command[j + 2] === '\n'))
      ) {
        // Bash removes a line continuation inside double quotes too, CRLF as outside them (#359).
        j += next === '\n' ? 2 : 3;
      } else if (char === escapeChar && (dialect === 'powershell' || '$`"\\'.includes(next))) {
        markEscape(add(next), next);
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
      markEscape(add(next === '\n' || crlf ? '' : (next ?? '')), next ?? '');
      i += crlf ? 3 : 2;
    } else if (char === ' ' || char === '\t') {
      endWord();
      i++;
    } else if (
      char === '(' &&
      dialect === 'powershell' &&
      isDelete(afterLeadingWords(segment)[0] ?? word)
    ) {
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
    } else if (char === '&' && (word?.text.endsWith('>') || command[i + 1] === '>')) {
      // Part of a redirection (2>&1, &>log), not a separator.
      add(char);
      i++;
    } else if (SEPARATORS.has(char)) {
      endSegment();
      // A PowerShell pipe feeds the next stage, also over a line break after it or before it, and
      // through a group's brackets, the call operator and a stage's script block; ;, && and || end
      // the statement, and so do an if's braces (#296).
      if (dialect === 'powershell') pipelineAt(char, i);
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
const afterLeadingWords = (words: Word[]): Word[] => {
  let rest = words;
  for (let skip = leadingWords(rest); skip > 0; skip = leadingWords(rest)) rest = rest.slice(skip);
  return rest;
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
    rest = afterLeadingWords(rest);
    const [first, ...operands] = rest;
    if (first === undefined) return undefined;
    // cmd reads switches written onto rd's or del's name as its first argument (rd/s/q, #296).
    const glued = first.dynamic ? null : CMD_GLUED_SWITCHES.exec(first.text);
    if (glued !== null) {
      const switches = { ...first, text: glued[2] ?? '' };
      return { program: (glued[1] ?? '').toLowerCase(), args: [switches, ...operands], chdirs };
    }
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

// Whether a word is one of push's long `options` as git reads it: the name before any `=`, whole or
// a prefix of it (--del). A prefix two options share (--d) counts too: git refuses it as
// ambiguous, and the gate does not count on that. No other push option is a prefix of one of
// these, so git's own list is not needed (ADR 0246).
const namesLong = (arg: string, options: readonly string[]): boolean => {
  const [name = ''] = arg.split('=', 1);
  return name.length > 2 && name.startsWith('--') && options.some((each) => each.startsWith(name));
};
const FORCE_OPTIONS = ['--force', '--force-with-lease', '--force-if-includes'];
const DELETE_OPTIONS = ['--delete', '--mirror', '--prune'];

// --force, --force-with-lease[=…], --force-if-includes or a prefix of one, -f alone or in a group
// such as -uf, or a +refspec.
const isForceArg = (arg: string): boolean =>
  namesLong(arg, FORCE_OPTIONS) || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || arg.startsWith('+');

// --delete, --mirror, --prune or a prefix of one, -d alone or in a group, or a :branch refspec.
const isDeleteOrMirrorArg = (arg: string): boolean =>
  namesLong(arg, DELETE_OPTIONS) || /^-[A-Za-z]*d[A-Za-z]*$/.test(arg) || arg.startsWith(':');

// What the gate found in a command and everything nested in it.
interface Findings {
  reasons: string[];
  // Where each push runs, the remote it names and the branch names its refspecs create.
  places: ({ place: Place } & PushTarget)[];
  // The pull requests `gh pr ready` marks ready, each needing its review summary, and where gh
  // runs.
  readies: { target: ReadyTarget; place: Place }[];
  // Whether any command read, decoded and nested ones too, mentions GH_REPO or GH_HOST.
  ghEnv: boolean;
  // The packages npx and its relatives run, each needing to be a binary the lockfile installed.
  packages: PackageRun[];
  // Whether any command read changes directory, so npx may run in another package.
  movesDir: boolean;
  // Whether any command read mentions GIT_CONFIG, or runs git config or git remote, any of which
  // may change what a push in the same command does (ADR 0246).
  configures: boolean;
  // The titles and bodies gh would post, for the personal denylist (ADR 0132).
  texts: GhText[];
  reads: number;
}

// What one reading of a command collects besides findings: more commands to read.
interface Reading {
  found: Findings;
  nested: string[];
  // Where the command being read runs.
  place: Place;
}

// git push's long options that take a value, after `=` or as the next word; git reads each by a
// unique prefix too (--push-opt). -o is the short one.
const PUSH_OPTIONS_WITH_VALUE = [
  '--repo',
  '--push-option',
  '--receive-pack',
  '--exec',
  '--recurse-submodules',
];

// A redirection word, and one that is only the operator, whose target is the next word.
const REDIRECTION = /^(?:\d+|&)?[<>]/;
const REDIRECTION_ONLY = /^(?:\d+|&)?(?:>>?|<<?<?|>\||[<>]&)$/;

// The remote a push names and the branch names its refspecs create on it (ADR 0114, ADR 0246).
interface PushTarget {
  // Its first operand, else --repo; undefined when it names none, null when computed at run time.
  remote: string | null | undefined;
  // Each refspec after the remote: the part after `:`, or the whole refspec, without a leading
  // `+`; null when it is computed at run time.
  destinations: (string | null)[];
}

const pushTarget = (args: Word[]): PushTarget => {
  let repo: Word | undefined;
  const operands: Word[] = [];
  let optionsEnd = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? { text: '', dynamic: false, quoted: false };
    // A redirection is the shell's (2>&1, >out.txt, &>log, 2> err.txt), with its target in the
    // next word when the word is only the operator.
    if (!arg.quoted && REDIRECTION.test(arg.text)) {
      if (REDIRECTION_ONLY.test(arg.text)) i++;
    } else if (optionsEnd || !arg.text.startsWith('-')) operands.push(arg);
    else if (arg.text === '--') optionsEnd = true;
    else if (arg.text === '-o') i++;
    else {
      // A long option or a prefix of it: one that may be --repo names the remote, and any other
      // that may take a value takes the next word when it has no `=` (review of #635).
      const [name = '', value] = arg.text.split(/=(.*)/s);
      const longs = PUSH_OPTIONS_WITH_VALUE.filter(
        (each) => name.length > 2 && each.startsWith(name),
      );
      const given = value === undefined ? args[i + 1] : { ...arg, text: value };
      if (longs.length === 1 && longs[0] === '--repo') repo = given;
      if (longs.length > 0 && value === undefined) i++;
    }
  }
  const [first, ...refspecs] = operands;
  const remote = first ?? repo;
  const destination = (refspec: string) => refspec.slice(refspec.indexOf(':') + 1);
  return {
    remote: remote === undefined ? undefined : remote.dynamic ? null : remote.text,
    destinations: refspecs.map((refspec) =>
      refspec.dynamic ? null : destination(refspec.text.replace(/^\+/, '')),
    ),
  };
};

// A git setting that may change what a push does: a remote's or push's (ADR 0246).
// An included file may hold either (review of #635).
const PUSH_SETTING = /^(?:remote|push|include|includeif)\./i;

// Whether a git subcommand's arguments only ask for its help: --help first, which git turns into
// `git help <command>`, or -h as the one argument, beside the shell's redirections (2>&1); it then
// pushes nothing (ADR 0246).
const printsHelp = (args: Word[]): boolean => {
  const [first, ...rest] = args;
  if (first === undefined || first.dynamic) return false;
  if (first.text === '--help') return true;
  return first.text === '-h' && rest.every((arg) => !arg.quoted && REDIRECTION.test(arg.text));
};

const readGit = (args: Word[], literal: boolean, { found, place }: Reading): void => {
  let i = 0;
  // Each -C is resolved against the ones before it, as git reads them.
  let gitPlace = place;
  // Whether -c or --config-env sets a remote's, push's or include setting, or one computed at run time.
  let configured = false;
  // Whether git only prints its help (git -h, git --help push).
  let help = false;
  while (args[i]?.text.startsWith('-')) {
    const option = args[i]?.text ?? '';
    const value = args[i + 1]?.text ?? '';
    if (option === '-C') gitPlace = moveTo(gitPlace, args[i + 1]?.dynamic ? undefined : value);
    // Only as git's first word: after an option the gate does not read, -h may be its value.
    if (i === 0 && (option === '-h' || option === '--help')) help = true;
    const setting =
      option === '-c' || option === '--config-env'
        ? args[i + 1]
        : option.startsWith('--config-env=')
          ? { ...(args[i] as Word), text: option.slice('--config-env='.length) }
          : undefined;
    if (setting !== undefined && (setting.dynamic || PUSH_SETTING.test(setting.text))) {
      configured = true;
    }
    i += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  const subcommand = args[i];
  if (subcommand?.text === 'config' || subcommand?.text === 'remote') found.configures = true;
  if (help || printsHelp(args.slice(i + 1))) return;
  if (subcommand?.text === 'push' || (literal && subcommand?.dynamic)) {
    found.places.push({ place: gitPlace, ...pushTarget(args.slice(i + 1)) });
    const pushArgs = args.slice(i + 1).map((word) => word.text);
    if (pushArgs.some(isForceArg)) found.reasons.push(FORCE_PUSH_BLOCKED);
    else if (pushArgs.some(isDeleteOrMirrorArg)) found.reasons.push(DELETE_PUSH_BLOCKED);
    else if (configured) found.reasons.push(CONFIGURED_PUSH_BLOCKED);
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

// The method of a `gh api` call, from its last -X or --method, also after -i in one group of short
// flags (-iX PUT): undefined when none is given, and COMPUTED when it is computed at run time.
const apiMethod = (args: Word[]): string | undefined => {
  const ungrouped = args.map((arg) => ({ ...arg, text: arg.text.replace(/^-i+X/, '-X') }));
  const method = lastOption(ungrouped, '-X', '--method');
  return method?.dynamic ? COMPUTED : method?.text.toUpperCase();
};

// Whether a `gh api` call merges a pull request: a PUT (or a method computed at run time) to a path
// or URL ending in pulls/<n>/merge, before any query string. A GET of the endpoint only asks
// whether the pull request is merged. GraphQL is not read: the ruleset on main and the
// maintainer's merge own merging (ADR 0135).
const MERGE_ENDPOINT = /(?:^|\/)pulls\/[^/?#]+\/merge(?:[?#].*)?$/s;
const apiMerges = (args: Word[]): boolean => {
  const method = apiMethod(args);
  return (
    (method === 'PUT' || method === COMPUTED) && args.some((arg) => MERGE_ENDPOINT.test(arg.text))
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

// A title or body gh would send, from the word that gives it: as it is, from a file where gh runs,
// or, when the gate cannot read it, why (ADR 0132). A file's path is resolved from the hook's
// working directory through the directories the command changes into.
const ghText = (
  command: string,
  field: string,
  value: Word,
  file: boolean,
  place: Place,
): GhText => {
  if (value.dynamic) return { kind: 'unreadable', command, field, why: 'computed at run time' };
  if (value.escaped) {
    return { kind: 'unreadable', command, field, why: 'a text with a PowerShell escape' };
  }
  if (!file) return { kind: 'text', command, field, text: value.text };
  if (value.text === '-') {
    return { kind: 'unreadable', command, field, why: 'read from standard input' };
  }
  if (place === undefined) {
    return { kind: 'unreadable', command, field, why: 'in a directory computed at run time' };
  }
  return { kind: 'file', command, field, path: [...place, value.text] };
};

// The gh pr and gh issue actions that post a title or a body, and the options that give them
// (cli.github.com/manual: gh pr create, edit and comment, gh issue create, edit and comment, and
// the `new` alias of create): -t/--title, -b/--body, -F/--body-file. The other short options of
// theirs that take a value (-a, -B, -H, -l, -m, -p, -r, -R, -T), so a group of short options
// reads as gh reads it: -dt <title> is --draft, then --title.
const POSTS = new Set(['create', 'new', 'edit', 'comment']);
const SHORT_TEXTS = new Map([
  ['t', '--title'],
  ['b', '--body'],
  ['F', '--body-file'],
]);
const SHORT_WITH_VALUE = 'aBbFHlmprRTt';
const LONG_TEXTS = new Set(['--title', '--body', '--body-file']);
const LONG_WITH_VALUE = new Set([
  ...LONG_TEXTS,
  '--assignee',
  '--attach',
  '--base',
  '--head',
  '--label',
  '--milestone',
  '--project',
  '--recover',
  '--reviewer',
  '--template',
  '--repo',
  '--add-assignee',
  '--add-label',
  '--add-project',
  '--add-reviewer',
  '--remove-assignee',
  '--remove-label',
  '--remove-project',
  '--remove-reviewer',
  '--type',
  '--parent',
]);

// The titles and bodies of a gh pr or gh issue command that posts them; each one given counts,
// though gh keeps the last.
const postedTexts = (command: string, args: Word[], place: Place): GhText[] => {
  const texts: GhText[] = [];
  const take = (field: string, value: Word | undefined) => {
    if (value !== undefined) {
      texts.push(ghText(command, field, value, field === '--body-file', place));
    }
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as Word;
    if (arg.text === '--') break;
    if (arg.text.startsWith('--')) {
      const [name = '', value] = arg.text.split(/=(.*)/s);
      if (value !== undefined) {
        if (LONG_TEXTS.has(name)) take(name, { ...arg, text: value });
      } else if (LONG_WITH_VALUE.has(name)) {
        if (LONG_TEXTS.has(name)) take(name, args[i + 1]);
        i++;
      }
      continue;
    }
    if (!arg.text.startsWith('-')) continue;
    // In a group of short options, the first that takes a value takes the rest of the word (after
    // an `=`, as gh's flag parser reads -t=…), or else the next word.
    const at = [...arg.text.slice(1)].findIndex((char) => SHORT_WITH_VALUE.includes(char));
    if (at < 0) continue;
    const field = SHORT_TEXTS.get(arg.text[at + 1] ?? '');
    const rest = arg.text.slice(at + 2).replace(/^=/, '');
    if (rest !== '') {
      if (field !== undefined) take(field, { ...arg, text: rest });
    } else {
      if (field !== undefined) take(field, args[i + 1]);
      i++;
    }
  }
  return texts;
};

// gh api's options that take a value besides its fields and --input, so a value is never read as
// an option.
const API_WITH_VALUE = new Set([
  '-H',
  '--header',
  '-q',
  '--jq',
  '-X',
  '--method',
  '-p',
  '--preview',
  '-t',
  '--template',
  '--hostname',
  '--cache',
]);
// The fields of a gh api call that carry a title or a body (ADR 0132).
const API_TEXT_FIELDS = new Set(['title', 'body']);

// The title and body fields of a gh api call and its --input, as gh reads them (cli.github.com/
// manual/gh_api): -f/--raw-field key=value as it is, -F/--field key=value read from a file after
// @ (@- for standard input), also joined to the option (-Fbody=…, --field=body=…) or after -i in
// one group of short options (-iF body=…), and --input <file> (- for standard input) as the
// request body. A field whose name is computed at run time may be either.
const apiTexts = (args: Word[], place: Place): GhText[] => {
  const command = 'gh api';
  const texts: GhText[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as Word;
    if (API_WITH_VALUE.has(arg.text)) {
      i++;
      continue;
    }
    const input = /^--input(?:=(.*))?$/s.exec(arg.text);
    if (input !== null) {
      const value = input[1] === undefined ? args[++i] : { ...arg, text: input[1] };
      if (value === undefined) continue;
      const text = ghText(command, '--input', value, true, place);
      texts.push(text.kind === 'file' ? { ...text, json: true } : text);
      continue;
    }
    const field = /^(?:(-i*f|--raw-field)|(-i*F|--field))(?:=?(.+))?$/s.exec(arg.text);
    if (field === null) continue;
    const value = field[3] === undefined ? args[++i] : { ...arg, text: field[3] };
    if (value === undefined) continue;
    const [, key, rest = ''] = /^([^=]*)=(.*)$/s.exec(value.text) ?? [];
    if (key === undefined || /[$`(@]/.test(key)) {
      if (value.dynamic) {
        texts.push({ kind: 'unreadable', command, field: 'field', why: 'computed at run time' });
      }
      continue;
    }
    if (!API_TEXT_FIELDS.has(key)) continue;
    const typedFile = field[2] !== undefined && rest.startsWith('@');
    const text = { ...value, text: typedFile ? rest.slice(1) : rest };
    texts.push(ghText(command, `field ${key}`, text, typedFile, place));
  }
  return texts;
};

const readGh = (args: Word[], literal: boolean, reading: Reading): void => {
  const { found } = reading;
  const [group, action, name] = positionals(args, GH_OPTIONS_WITH_VALUE);
  // What gh would post, against the personal denylist (ADR 0132).
  if ((group?.text === 'pr' || group?.text === 'issue') && !group.dynamic && action) {
    if (!action.dynamic && POSTS.has(action.text)) {
      found.texts.push(...postedTexts(`gh ${group.text} ${action.text}`, args, reading.place));
    }
  } else if (group?.text === 'api' && !group.dynamic) {
    found.texts.push(...apiTexts(args, reading.place));
  }
  if (group?.text === 'pr' || (literal && group?.dynamic)) {
    if (action?.dynamic || (group?.dynamic && action?.text === 'merge')) {
      found.reasons.push(COMPUTED_PR_ACTION_BLOCKED);
    } else if (action?.text === 'merge') found.reasons.push(PR_MERGE_BLOCKED);
    else if (action?.text === 'ready') readReady(args, name, reading);
  }
  // A group computed at run time may be pr or api, so it is read as both.
  if ((group?.text === 'api' || group?.dynamic) && apiMerges(args)) {
    found.reasons.push(PR_MERGE_BLOCKED);
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
const CMD_GLUED_SWITCHES = /^(rd|rmdir|del|erase)((?:\/[a-z]+)+)$/i;
// A PowerShell splat, whose table may carry Recurse and the path (#296).
const isSplat = (word: Word): boolean => !word.quoted && /^@\w+$/.test(word.text);
const isDelete = (word: Word | undefined): boolean =>
  word !== undefined &&
  !word.dynamic &&
  (programName(word.text) === 'rm' || REMOVE_ITEM.has(programName(word.text)));

// A recursive delete whose path holds a variable or a substitution: bash's and PowerShell's $…,
// $( ) and bash's backticks, which the lexer marks as computed, PowerShell's @( ), and cmd's %…%
// (#281), in its arguments or in the earlier stages of a PowerShell pipeline into it (`input`),
// or any splat (#296). A PowerShell switch given a value (-Recurse:$true) and a redirection
// (2>$null) are no path.
const deletesComputedPath = (program: string, args: Word[], input: Word[]): boolean => {
  const recurses =
    program === 'rm'
      ? recursesRm
      : REMOVE_ITEM.has(program)
        ? (word: Word) =>
            recursesPowershell(word) || (CMD_DELETES.has(program) && recursesCmd(word))
        : undefined;
  if (recurses === undefined) return false;
  if (args.some(isSplat)) return true;
  if (!args.some(recurses)) return false;
  return [...input, ...args].some((word) => {
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
// its ^ escapes and the line breaks they continue (#158).
const cmdCommands = (args: Word[]): string[] => {
  const run = args.findIndex((arg) => /^\/\/?[ck]$/i.test(arg.text));
  return run < 0 ? [] : [text(args.slice(run + 1)).replace(/\^(?:\r?\n)?/g, '')];
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
const readInvocation = (
  { program, args }: Invocation,
  reading: Reading,
  input: Word[],
): boolean => {
  if (program === 'git' || program === COMPUTED) readGit(args, program === 'git', reading);
  if (program === 'gh' || program === COMPUTED) readGh(args, program === 'gh', reading);
  if (deletesComputedPath(program, args, input)) {
    reading.found.reasons.push(VARIABLE_DELETE_BLOCKED);
  }
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
  if (/GIT_CONFIG/i.test(normalised(command))) found.configures = true;
  if (depth > MAX_DEPTH || found.reads > MAX_READS) {
    found.reasons.push(TOO_DEEP_BLOCKED);
    return;
  }
  const nested = new Set<string>();
  const unquoted = new Set<string>();
  let moved = false;
  for (const dialect of dialects) {
    const lexed = lex(command, dialect);
    const reading: Reading = { found, nested: [...lexed.substitutions], place: base };
    // A change of directory lasts for the rest of the command.
    let place = base;
    let runsText = false;
    for (const [k, words] of lexed.segments.entries()) {
      const called = invocation(words, reading.nested, found);
      if (called === undefined) continue;
      if (called.moves !== undefined) place = moveTo(place, destination(called.moves, called.args));
      moved ||= called.moves !== undefined || called.chdirs.length > 0;
      reading.place = called.chdirs.reduce(moveTo, place);
      if (readInvocation(called, reading, lexed.inputs[k] ?? [])) runsText = true;
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
  }
  for (const each of nested) {
    if (each.trim() !== '') read(each, depth + 1, found, DIALECTS, moved ? undefined : base);
  }
  for (const each of unquoted) read(each, depth + 1, found, DIALECTS, base);
};

export const findings = (command: string, dialects: readonly Dialect[] = DIALECTS): Findings => {
  const found: Findings = {
    reasons: [],
    places: [],
    readies: [],
    ghEnv: false,
    packages: [],
    movesDir: false,
    configures: false,
    texts: [],
    reads: 0,
  };
  read(command, 0, found, dialects, []);
  if (found.places.length > 0 && found.configures) found.reasons.push(CONFIGURED_PUSH_BLOCKED);
  return found;
};

// The pull request `gh pr ready` names: its number, URL or branch (none for the current branch's),
// and the repository given with -R.
export interface ReadyTarget {
  pr?: string;
  repo?: string;
}
