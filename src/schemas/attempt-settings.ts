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
    permissions: z.strictObject({ allow: z.array(BrewerAllowedTool), deny: z.array(ToolRule) }),
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
