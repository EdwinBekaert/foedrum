// Building blocks shared by the recipe, brewer and configuration schemas.

import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

/** A wall-clock limit: a positive whole number of seconds, minutes, hours or days ("30m"). */
export const Duration = z
  .string()
  .regex(/^[1-9][0-9]*[smhd]$/, 'Must be a whole number followed by s, m, h or d, such as "30m"')
  .describe('A positive whole number of seconds, minutes, hours or days: "90s", "30m", "2h", "3d"');

// Segments separated by `/`, none of them empty, `.` or `..`; no `\` or `:` (drive letters,
// alternate data streams) and no line breaks.
const segment = String.raw`(?!\.\.?(?:/|$))[^/\\:\r\n]+`;

/** A path inside the worktree: relative, with forward slashes, never leaving it. */
export const RelativePath = z
  .string()
  .regex(
    new RegExp(`^${segment}(?:/${segment})*$`),
    'Must be a relative path with forward slashes, without "." or ".." segments',
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
  (rule) => toolOf(rule) !== 'AskUserQuestion',
  'AskUserQuestion is always denied',
);

const toolOf = (rule: string): string => rule.split('(', 1)[0] ?? rule;

/**
 * Whether an allowlist entry stays within the ceiling: a ceiling entry covers the same tool when
 * it has no specifier, or when its specifier, with `*` matching any text, matches the entry's
 * specifier as written. A `*` in the entry is only covered by a `*` of the ceiling.
 */
export function withinCeiling(entry: string, ceiling: readonly string[]): boolean {
  const wanted = parseRule(entry);
  return ceiling.some((rule) => {
    const limit = parseRule(rule);
    if (limit.tool !== wanted.tool) return false;
    if (limit.specifier === undefined) return true;
    return wanted.specifier !== undefined && globMatches(limit.specifier, wanted.specifier);
  });
}

const parseRule = (rule: string): { tool: string; specifier?: string } => {
  const open = rule.indexOf('(');
  return open === -1
    ? { tool: rule }
    : { tool: rule.slice(0, open), specifier: rule.slice(open + 1, -1) };
};

/** `*` matches any text, every other character itself; linear backtracking, no regular expression. */
function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
