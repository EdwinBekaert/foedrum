// Building blocks shared by the recipe, brewer and configuration schemas.

import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

/** A wall-clock limit: a positive whole number of seconds, minutes, hours or days ("30m"). */
export const Duration = z
  .string()
  .regex(/^[1-9][0-9]*[smhd]$/, 'Must be a whole number followed by s, m, h or d, such as "30m"')
  .describe('A positive whole number of seconds, minutes, hours or days: "90s", "30m", "2h", "3d"');

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
);

/**
 * Whether a shell rule may match git with no fixed subcommand: a whole shell, a star before the
 * subcommand, an option or a quote where it would be, or a subcommand that is or could become
 * `push`. Lower case, since PowerShell matches without case; `:*` is the older spelling of ` *`.
 */
export function reachesAnyGitCommand(rule: string): boolean {
  const { tool, specifier } = parseRule(rule);
  if (!commandTools.has(tool)) return false;
  if (specifier === undefined) return true;
  const command = (
    specifier.endsWith(':*') ? `${specifier.slice(0, -2)} *` : specifier
  ).toLowerCase();
  const star = command.indexOf('*');
  const fixed = star === -1 ? command : command.slice(0, star);
  if (star !== -1 && ['git ', 'git.exe '].some((git) => git.startsWith(fixed))) return true;
  if (!/^git(?:\.exe)?(?:\s|$)/.test(fixed)) return false;
  const subcommand = /^git(?:\.exe)?\s+([a-z][a-z0-9-]*)(?=\s|$)/.exec(fixed);
  if (subcommand === null) return true;
  const [whole, name = ''] = subcommand;
  const extendable = star !== -1 && whole.length === fixed.length;
  return name === 'push' || (extendable && 'push'.startsWith(name));
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
