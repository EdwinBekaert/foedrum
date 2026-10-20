// The settings file the brewer runner writes for each attempt and passes as `claude --settings`
// (ADR 0042, ADR 0046). claude drops a file that fails its own validation silently, deny rules
// included, so only the keys the runner uses exist here, strictly.

import { BrewerAllowedTool, parseRule, ToolRule } from './primitives.ts';
import { z } from './zod.ts';

/** The shells whose `git push` every attempt denies (brewers-and-recipes §1.1). */
const SHELL_TOOLS = ['Bash', 'PowerShell'] as const;

/** The deny rules every attempt has, given the rules it allows. */
export const alwaysDenied = (allow: readonly string[]): string[] => {
  const tools = new Set(allow.map((rule) => parseRule(rule).tool));
  return [
    'AskUserQuestion',
    ...SHELL_TOOLS.filter((tool) => tools.has(tool)).map((tool) => `${tool}(git push *)`),
  ];
};

/**
 * What every sandboxed command is kept from (ADR 0087): the logins of gh, git's credential store,
 * ssh, AWS, npm and Claude Code itself, as files and as variables. The sandbox lets a command read
 * most of the machine and inherit Claude Code's environment, and has no deny list of its own.
 */
export const sandboxCredentials = {
  files: [
    '~/.config/gh',
    '~/.git-credentials',
    '~/.config/git/credentials',
    '~/.ssh',
    '~/.aws',
    '~/.npmrc',
    '~/.claude/.credentials.json',
    '~/.config/anthropic',
  ].map((path) => ({ path, mode: 'deny' as const })),
  envVars: [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'NPM_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ].map((name) => ({ name, mode: 'deny' as const })),
};

// Claude Code checks file permissions against Read(path) and Edit(path) rules only: Edit rules
// cover every tool that edits files, and Read rules, best-effort, Grep and Glob. It never consults
// a path rule for Write, MultiEdit, NotebookEdit or Glob (ADR 0093).
const consultedFor: Readonly<Record<string, 'Read' | 'Edit'>> = {
  Read: 'Read',
  Grep: 'Read',
  Glob: 'Read',
  Edit: 'Edit',
  Write: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
};
const unconsultedPathTools = new Set(['Write', 'MultiEdit', 'NotebookEdit', 'Glob']);

/** A brewer's worktree, claude's working directory, as a path rule's pattern. */
const WORKTREE = './**';

/** The rule to write for a bare file-tool rule: its tool's rule scoped to the worktree. */
export const scopedRule = (rule: string): string => {
  const { tool, specifier } = parseRule(rule);
  const consulted = Object.hasOwn(consultedFor, tool) ? consultedFor[tool] : undefined;
  return consulted === undefined || specifier !== undefined ? rule : `${consulted}(${WORKTREE})`;
};

/** Why claude would not read a rule the way it seems to, with the rule to write instead. */
const fileRuleProblem = (rule: string, list: 'allow' | 'deny'): string | undefined => {
  const { tool, specifier } = parseRule(rule);
  if (specifier !== undefined && unconsultedPathTools.has(tool)) {
    return `Claude Code never consults a ${tool} path rule such as "${rule}": write "${consultedFor[tool]}(${specifier})"`;
  }
  if (list === 'allow' && specifier === undefined && Object.hasOwn(consultedFor, tool)) {
    return `A bare "${tool}" allows it anywhere on disk: write "${scopedRule(rule)}" for the worktree`;
  }
  return undefined;
};

const fileRules =
  (list: 'allow' | 'deny') =>
  (rules: readonly string[], ctx: z.RefinementCtx): void => {
    for (const [index, rule] of rules.entries()) {
      const message = fileRuleProblem(rule, list);
      if (message !== undefined) ctx.addIssue({ code: 'custom', message, path: [index] });
    }
  };

const Credentials = z
  .strictObject({
    files: z.array(z.strictObject({ path: z.string(), mode: z.literal('deny') })),
    envVars: z.array(z.strictObject({ name: z.string(), mode: z.literal('deny') })),
  })
  .refine(
    ({ files, envVars }) =>
      sandboxCredentials.files.every(({ path }) => files.some((file) => file.path === path)) &&
      sandboxCredentials.envVars.every(({ name }) => envVars.some((env) => env.name === name)),
    'Must hide every credential the attempt settings name from sandboxed commands',
  );

export const AttemptSettings = z
  .strictObject({
    permissions: z.strictObject({
      allow: z.array(BrewerAllowedTool).superRefine(fileRules('allow')),
      deny: z.array(ToolRule).superRefine(fileRules('deny')),
    }),
    // Only where the isolation level relies on Claude Code's sandbox: it must run, or nothing does,
    // and the allow rules decide for sandboxed commands too (ADR 0087).
    sandbox: z
      .strictObject({
        enabled: z.literal(true),
        failIfUnavailable: z.literal(true),
        allowUnsandboxedCommands: z.literal(false),
        autoAllowBashIfSandboxed: z.literal(false),
        credentials: Credentials,
      })
      .optional(),
  })
  .refine(
    ({ permissions: { allow, deny } }) => alwaysDenied(allow).every((rule) => deny.includes(rule)),
    'Must deny AskUserQuestion, and git push in every shell it allows',
  );
export type AttemptSettings = z.infer<typeof AttemptSettings>;
