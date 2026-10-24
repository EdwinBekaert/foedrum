// Building blocks shared by the recipe, brewer and configuration schemas.

import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

/** A wall-clock limit: a positive whole number of seconds, minutes, hours or days ("30m"). */
export const Duration = z
  .string()
  .regex(/^[1-9][0-9]*[smhd]$/, 'Must be a whole number followed by s, m, h or d, such as "30m"')
  .describe('A positive whole number of seconds, minutes, hours or days: "90s", "30m", "2h", "3d"');

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** A `Duration` ("30m") in milliseconds. */
export const durationMs = (duration: string): number =>
  Number(duration.slice(0, -1)) * UNIT_MS[duration.slice(-1) as keyof typeof UNIT_MS];

// `con` → `[cC][oO][nN]`: the generated JSON Schema keeps a pattern but not its flags.
const anyCase = (word: string): string =>
  [...word].map((letter) => `[${letter}${letter.toUpperCase()}]`).join('');
const device = `(?:${['con', 'prn', 'aux', 'nul'].map(anyCase).join('|')}|(?:${anyCase('com')}|${anyCase('lpt')})[1-9])`;
// A file name every OS can create as written: none of the characters Windows reserves (`\` and
// `:` also rule out drive letters and alternate data streams), no line breaks, no trailing dot or
// space (Windows drops them, which also rules out `.` and `..`), and no device name. Control
// characters (NUL included) are invalid in Windows file names, and NUL everywhere.
const char = String.raw`[^/\\:*?"<>|\x00-\x1f]`;
const segment = String.raw`(?!${device}(?:\.|/|$))${char}*[^/\\:*?"<>|\x00-\x1f. ]`;

/** A path inside the worktree: relative, with forward slashes, never leaving it. */
export const RelativePath = z
  .string()
  .regex(
    new RegExp(`^${segment}(?:/${segment})*$`),
    'Must be a relative path with forward slashes, file names that are valid on Windows, and no "." or ".." segments',
  );

/** The abstract checks recipes name; each repository maps them to commands (ADR 0023). */
export const CheckName = z.enum(['build', 'typecheck', 'lint', 'format', 'test']);
export type CheckName = z.infer<typeof CheckName>;

const CommandLine = NonEmpty.regex(/^[^\r\n]*$/, 'Must be one line');

/** A command with optional per-OS overrides, run through the platform shell (architecture §13). */
export const CommandObject = z.strictObject({
  run: CommandLine,
  windows: CommandLine.optional(),
  macos: CommandLine.optional(),
  linux: CommandLine.optional(),
});
export type CommandObject = z.infer<typeof CommandObject>;

export const Command = z.union([CommandLine, CommandObject]);
export type Command = z.infer<typeof Command>;

/** A Claude Code permission rule: a tool name, optionally with a specifier (`Bash(git diff*)`). */
export const ToolRule = z
  .string()
  .regex(/^[A-Za-z][\w-]*(?:\([^\r\n]+\))?$/, 'Must be a tool name, optionally with "(specifier)"');

// Claude Code checks file permissions against Read(path) and Edit(path) rules only: Edit rules
// cover every tool that edits files, and Read rules, best-effort, Grep and Glob. It never consults
// a path rule for Write, MultiEdit, NotebookEdit or Glob (ADR 0093).
export const consultedFor: Readonly<Record<string, 'Read' | 'Edit'>> = {
  Read: 'Read',
  Grep: 'Read',
  Glob: 'Read',
  Edit: 'Edit',
  Write: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
};
const unconsultedPathTools = new Set(['Write', 'MultiEdit', 'NotebookEdit', 'Glob']);

/** Why Claude Code would never consult a path rule, naming the rule to write instead. */
const unconsultedPathRule = (rule: string, ctx: z.RefinementCtx): void => {
  const { tool, specifier } = parseRule(rule);
  if (specifier === undefined || !unconsultedPathTools.has(tool)) return;
  ctx.addIssue({
    code: 'custom',
    message: `Claude Code never consults a ${tool} path rule such as "${rule}": write "${consultedFor[tool]}(${specifier})"`,
  });
};

/** A deny rule of a brewer or an attempt: never a path rule Claude Code would not consult. */
export const BrewerDeniedTool = ToolRule.superRefine(unconsultedPathRule);

/** An allowlist entry: never AskUserQuestion, which is always denied (ADR 0006). */
export const AllowedTool = ToolRule.refine(
  (rule) => parseRule(rule).tool !== 'AskUserQuestion',
  'AskUserQuestion is always denied',
);

/**
 * A rule a brewer's attempt may allow: never one that reaches git with no fixed subcommand. claude
 * matches a deny rule against the command as written, so `git -C . push` gets past
 * `Bash(git push *)`; a push is denied only when no allow rule matches it (ADR 0062).
 */
export const BrewerAllowedTool = AllowedTool.refine(
  (rule) => !reachesAnyGitCommand(rule),
  'Must not allow git with no fixed subcommand, such as "Bash(git *)": a push with options before it gets past every deny rule (ADR 0062)',
)
  .refine(
    (rule) => !reachesGh(rule),
    'Must not allow gh, or a rule that may start it, such as "Bash(gh *)": only the engine talks to GitHub, with the maintainer\'s gh login (ADR 0082)',
  )
  .superRefine(unconsultedPathRule);

/**
 * A rule of the permission ceiling or of a repository's tools: never one that names gh. These are
 * not allowlists, so a broad rule such as `Bash(*)` stays; what reaches an attempt is checked by
 * `BrewerAllowedTool` (ADR 0082).
 */
export const CeilingTool = AllowedTool.refine(
  (rule) => !namesGh(rule),
  'Must not name gh, such as "Bash(gh *)": only the engine talks to GitHub, with the maintainer\'s gh login (ADR 0082)',
);

// git subcommands that update a remote, and `submodule` (`submodule foreach` runs a command). Not
// complete: a subcommand that runs a command from its own line (`rebase -x`, `fetch
// --upload-pack`) is out of this check's reach, as is any such program (ADR 0062).
const pushingSubcommands = ['push', 'send-pack', 'http-push', 'subtree', 'submodule'];
// Common programs that run the rest of their command line as a command (Windows extensions
// dropped); a known list, not a complete one (ADR 0062).
const wrappers = new Set([
  ...['env', 'command', 'exec', 'builtin', 'xargs', 'sudo', 'doas', 'nice', 'nohup', 'time'],
  ...[
    'timeout',
    'stdbuf',
    'npx',
    'bunx',
    'pnpx',
    'eval',
    'source',
    '.',
    'iex',
    'invoke-expression',
  ],
  ...['start-process', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'pwsh', 'powershell'],
]);
// The package managers read by their subcommand, each with whether a subcommand is a runner: it
// runs the rest of the line as a command, as `npx` does (ADR 0165). npm resolves any start of
// `exec` or `explore`. The others read any other subcommand as the program word of the rest.
const packageManagers = new Map<string, (subcommand: string) => boolean>([
  ['npm', (word) => word === 'x' || 'exec'.startsWith(word) || 'explore'.startsWith(word)],
  ['pnpm', (word) => word === 'exec' || word === 'dlx'],
  ['yarn', (word) => word === 'exec' || word === 'dlx'],
  ['bun', (word) => word === 'x' || word === 'run'],
  ['corepack', () => false],
]);
// A program word without quotes, call operators, assignments or variables: a name or a path.
const plainProgram = /^[a-z0-9._/\\:-]+$/;
// The extensions Windows runs a program by (PATHEXT): `git.cmd` is git too. PowerShell runs `.ps1`.
const windowsExtension = /\.(?:exe|com|bat|cmd)$/;
const powerShellExtension = /\.(?:exe|com|bat|cmd|ps1)$/;
const gitWord = /(?:^|[\s/\\'"=])git(?:-[a-z0-9-]+)?(?:\.(?:exe|com|bat|cmd))?(?=[\s'"]|$)/;
const ghWord = /(?:^|[\s/\\'"=])gh(?:\.(?:exe|com|bat|cmd))?(?=[\s'"]|$)/;
const gitSubcommand = /^\s+([a-z][a-z0-9-]*)(?=\s|$)/;
// A package manager's subcommand: no option, quote, star or escape.
const packageSubcommand = /^\s+([a-z0-9._][a-z0-9._-]*)(?=\s|$)/;
// What follows a program can be read as written only in plain characters: anything else may be a
// quote, an escape or an expansion of the shell a wrapper starts (`env g""h`, `env /usr/bin/g?`,
// `cmd /c g^h`, `bash -c g\h` run gh), so it fails closed (review of #225).
const plainRest = /^[\sa-z0-9._/:=@+,-]*$/;

/**
 * What a rule lets a shell run, read from its program word: not a shell rule (`none`); any program
 * (`any`: a whole shell, a star in or right after the program word, a program word with a quote,
 * `&`, `$` or an assignment, or in Bash a backslash, which quotes there); or a program by its
 * name, without its path and Windows extension, with what follows it up to the first star, and
 * whether that can be read as written. `any` keeps the name of a plain program word with a star
 * right after it (`gh*`). Lower case, since PowerShell matches without case; `:*` is the older
 * spelling of ` *`.
 */
type ShellProgram =
  | { kind: 'none' }
  | { kind: 'any'; name?: string }
  | { kind: 'program'; name: string; rest: string; star: boolean; unreadable: boolean };

function shellProgramOf(rule: string): ShellProgram {
  const { tool, specifier } = parseRule(rule);
  if (!commandTools.has(tool)) return { kind: 'none' };
  if (specifier === undefined) return { kind: 'any' };
  const command = (specifier.endsWith(':*') ? `${specifier.slice(0, -2)} *` : specifier)
    .trimStart()
    .toLowerCase();
  const star = command.indexOf('*');
  const fixed = star === -1 ? command : command.slice(0, star);
  const program = /^\S*/.exec(fixed)?.[0] ?? '';
  if (!plainProgram.test(program)) return { kind: 'any' };
  if (tool === 'Bash' && program.includes('\\')) return { kind: 'any' };
  return readProgram(tool, program, fixed.slice(program.length), star !== -1);
}

/**
 * A program word with what follows it up to the first star. A package manager is read by its
 * subcommand (ADR 0165): a runner is read as `npx`; for pnpm, yarn, bun and corepack, any other
 * subcommand is the program word of the rest; an option, a star or an unreadable word in its place
 * is any program.
 */
function readProgram(tool: string, word: string, rest: string, star: boolean): ShellProgram {
  const extension = tool === 'PowerShell' ? powerShellExtension : windowsExtension;
  const base = (word.split(/[/\\]/).at(-1) ?? '').replace(extension, '');
  const name = base === 'yarnpkg' ? 'yarn' : base;
  if (star && rest === '') return { kind: 'any', name };
  const unreadable = !plainRest.test(rest);
  const isRunner = packageManagers.get(name);
  if (isRunner === undefined) return { kind: 'program', name, rest, star, unreadable };
  const subcommand = packageSubcommand.exec(rest);
  if (subcommand === null) {
    return star || /\S/.test(rest)
      ? { kind: 'any' }
      : { kind: 'program', name, rest, star, unreadable };
  }
  const [whole, next = ''] = subcommand;
  const after = rest.slice(whole.length);
  if (isRunner(next)) return { kind: 'program', name: 'npx', rest: after, star, unreadable };
  if (name === 'npm') return { kind: 'program', name, rest, star, unreadable };
  return readProgram(tool, next, after, star);
}

/**
 * Whether a shell rule may match git with no fixed subcommand, failing closed on the program word:
 * any program (`shellProgramOf`); a wrapper with a star, with what follows it unreadable, or with
 * git after it; git's own
 * `git-<name>` programs with a star, or one that pushes; or git, by name or path, with an option,
 * a quote or a star where the subcommand would be, or with a subcommand that pushes or that a
 * star could make into one.
 */
function reachesAnyGitCommand(rule: string): boolean {
  const program = shellProgramOf(rule);
  if (program.kind !== 'program') return program.kind === 'any';
  const { name, rest, star, unreadable } = program;
  if (wrappers.has(name)) return star || unreadable || gitWord.test(rest);
  if (name.startsWith('git-')) return star || pushingSubcommands.includes(name.slice(4));
  if (name !== 'git') return false;
  const subcommand = gitSubcommand.exec(rest);
  if (subcommand === null) return true;
  const [whole, word = ''] = subcommand;
  const extendable = star && whole.length === rest.length;
  return pushingSubcommands.some(
    (pushing) => pushing === word || (extendable && pushing.startsWith(word)),
  );
}

/** Whether a shell rule names gh: gh by name or path, or a wrapper with gh after it (ADR 0082). */
function namesGh(rule: string): boolean {
  const program = shellProgramOf(rule);
  if (program.kind === 'none') return false;
  if (program.name === 'gh') return true;
  return program.kind === 'program' && wrappers.has(program.name) && ghWord.test(program.rest);
}

/**
 * Whether a shell rule may start gh, failing closed as `reachesAnyGitCommand` does: any program,
 * a rule that names gh with any arguments, a wrapper with a star or with what follows it
 * unreadable, or git asking its credential helper for the login (ADR 0082).
 */
function reachesGh(rule: string): boolean {
  const program = shellProgramOf(rule);
  if (program.kind !== 'program') return program.kind === 'any';
  if (namesGh(rule)) return true;
  const { name, rest, star, unreadable } = program;
  if (wrappers.has(name)) return star || unreadable;
  return asksGitCredential(name, rest, star);
}

const credential = 'credential';

/**
 * Whether a git rule may ask git's credential helper, which on a Brewery is `gh auth
 * git-credential` (ADR 0073), for the login: `git credential`, `git credential-<helper>`,
 * `git-credential-<helper>`, or a star that could make the subcommand into one (`git c*`).
 */
function asksGitCredential(name: string, rest: string, star: boolean): boolean {
  if (name.startsWith('git-')) return name.slice(4).startsWith(credential);
  if (name !== 'git') return false;
  const subcommand = gitSubcommand.exec(rest);
  if (subcommand === null) return false;
  const [whole, word = ''] = subcommand;
  const extendable = star && whole.length === rest.length;
  return word.startsWith(credential) || (extendable && credential.startsWith(word));
}

// Tools whose specifier is a command (Claude Code splits it on shell operators) or a path
// (gitignore-style, where `*` stays within one folder and `**` crosses folders).
const commandTools = new Set(['Bash', 'PowerShell']);
const pathTools = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Operators, substitutions, redirections, and the grouping PowerShell evaluates as a command
// (`(…)`, `{…}`); a star fails closed on all of them.
const shellOperator = /[;&|`$<>(){}]/;
const parentSegment = /(?:^|[/\\])\.\.(?:[/\\]|$)/;
// Claude Code reads `//path` as absolute, `/path` from the settings file, `~/path` from home.
const anchoredPath = /^[/~]/;

/** Whether a specifier may reach outside what a glob of the ceiling seems to cover. */
const escapes = (tool: string, specifier: string): boolean =>
  parentSegment.test(specifier) || (pathTools.has(tool) && anchoredPath.test(specifier));

/**
 * Whether an allowlist entry stays within the ceiling, failing closed: a ceiling rule covers the
 * same tool when it has no specifier, when its specifier is the entry's, or when its specifier,
 * read as a glob, matches the entry's specifier as written. A star never stands for a shell
 * operator in a command rule, a single star never stands for `/` or `*` in a path rule, and an
 * entry with a `..` segment, or a path rule anchored at `/` or `~`, is only covered by the same
 * specifier.
 */
export function withinCeiling(entry: string, ceiling: readonly string[]): boolean {
  const wanted = parseRule(entry);
  return ceiling.some((rule) => {
    const limit = parseRule(rule);
    if (limit.tool !== wanted.tool) return false;
    if (limit.specifier === undefined || limit.specifier === wanted.specifier) {
      return true;
    }
    if (wanted.specifier === undefined || escapes(wanted.tool, wanted.specifier)) return false;
    return globMatches(globOf(limit.tool, limit.specifier), wanted.specifier);
  });
}

export const parseRule = (rule: string): { tool: string; specifier?: string } => {
  const open = rule.indexOf('(');
  return open === -1
    ? { tool: rule }
    : { tool: rule.slice(0, open), specifier: rule.slice(open + 1, -1) };
};

/** A literal character, or a star: what it may stand for, one character at a time. */
type GlobToken = string | ((char: string) => boolean);

function globOf(tool: string, specifier: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < specifier.length; i++) {
    const char = specifier[i] as string;
    if (char !== '*') {
      tokens.push(char);
    } else if (pathTools.has(tool) && specifier[i + 1] === '*') {
      tokens.push(() => true);
      i++;
    } else if (pathTools.has(tool)) {
      tokens.push((text) => text !== '/' && text !== '\\' && text !== '*');
    } else if (commandTools.has(tool)) {
      tokens.push((text) => !shellOperator.test(text));
    } else {
      tokens.push(() => true);
    }
  }
  return tokens;
}

/** Whether the tokens match all of `text`; O(tokens × text), no regular expression. */
function globMatches(tokens: readonly GlobToken[], text: string): boolean {
  // matched[j]: the tokens so far match the first j characters of text.
  let matched = Array.from({ length: text.length + 1 }, (_, j) => j === 0);
  for (const token of tokens) {
    const next: boolean[] = [];
    for (let j = 0; j <= text.length; j++) {
      const before = text[j - 1] ?? '';
      next[j] =
        typeof token === 'string'
          ? j > 0 && matched[j - 1] === true && before === token
          : matched[j] === true || (j > 0 && next[j - 1] === true && token(before));
    }
    matched = next;
  }
  return matched[text.length] === true;
}
