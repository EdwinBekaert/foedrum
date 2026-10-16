// The settings file the brewer runner writes for each attempt and passes as `claude --settings`
// (ADR 0042, ADR 0046). claude drops a file that fails its own validation silently, deny rules
// included, so only the keys the runner uses exist here, strictly.

import { AllowedTool, parseRule, ToolRule } from './primitives.ts';
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

export const AttemptSettings = z
  .strictObject({
    permissions: z.strictObject({ allow: z.array(AllowedTool), deny: z.array(ToolRule) }),
    // Only where the isolation level relies on Claude Code's sandbox: it must run, or nothing does.
    sandbox: z
      .strictObject({
        enabled: z.literal(true),
        failIfUnavailable: z.literal(true),
        allowUnsandboxedCommands: z.literal(false),
      })
      .optional(),
  })
  .refine(
    ({ permissions: { allow, deny } }) => alwaysDenied(allow).every((rule) => deny.includes(rule)),
    'Must deny AskUserQuestion, and git push in every shell it allows',
  );
export type AttemptSettings = z.infer<typeof AttemptSettings>;
