// The events of `claude --output-format stream-json` that the brewer runner reads (ADR 0042).
// Loose objects: claude adds fields freely, and the runner reads only these.

import { z } from './zod.ts';

/** `system/init`: what claude set up for the session, checked against what the runner asked. */
export const ClaudeInit = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  model: z.string(),
  permissionMode: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.looseObject({ name: z.string() })),
  skills: z.array(z.unknown()),
  slash_commands: z.array(z.unknown()),
  claude_code_version: z.string(),
});
export type ClaudeInit = z.infer<typeof ClaudeInit>;
