// The settings file the brewer runner writes for each attempt and passes as `claude --settings`
// (ADR 0042, ADR 0045). claude drops a file that fails its own validation silently, deny rules
// included, so only the keys the runner uses exist here, strictly.

import { AllowedTool, ToolRule } from './primitives.ts';
import { z } from './zod.ts';

export const AttemptSettings = z.strictObject({
  permissions: z.strictObject({ allow: z.array(AllowedTool), deny: z.array(ToolRule) }),
  // Only where the isolation level relies on Claude Code's sandbox: it must run, or nothing does.
  sandbox: z
    .strictObject({
      enabled: z.literal(true),
      failIfUnavailable: z.literal(true),
      allowUnsandboxedCommands: z.literal(false),
    })
    .optional(),
});
export type AttemptSettings = z.infer<typeof AttemptSettings>;
