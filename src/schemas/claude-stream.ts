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

/** Any stream-json event: one JSON object with a type per line. */
export const ClaudeEvent = z.looseObject({ type: z.string() });

const Block = z.looseObject({ type: z.string() });
/** A tool call in an assistant message. */
export const ClaudeToolUse = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
/** A tool call's result in a user message. */
export const ClaudeToolResult = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
});

/** `assistant`: a message of the model, or, with `error`, one claude made up for a failed call. */
export const ClaudeAssistant = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({ id: z.string(), content: z.array(Block) }),
  /** Set for a subagent's messages. */
  parent_tool_use_id: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type ClaudeAssistant = z.infer<typeof ClaudeAssistant>;

/** `user`: the results of the tool calls. */
export const ClaudeUser = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({ content: z.union([z.array(Block), z.string()]) }),
});
export type ClaudeUser = z.infer<typeof ClaudeUser>;

/** `system/permission_denied`: one denied tool call. */
export const ClaudeDenial = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('permission_denied'),
  tool_name: z.string(),
  /**
   * The denied call, for the command it was refused (ADR 0172); one it cannot read is left out,
   * so the denial is still counted.
   */
  tool_use_id: z.string().optional().catch(undefined),
});

const Tokens = z.int().nonnegative();

/** `result`: how the run ended, always the last line. `is_error` decides (ADR 0042). */
export const ClaudeResult = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  num_turns: Tokens.optional(),
  terminal_reason: z.string().optional(),
  errors: z.array(z.string()).optional(),
  result: z.string().optional(),
  usage: z
    .looseObject({
      input_tokens: Tokens,
      output_tokens: Tokens,
      cache_read_input_tokens: Tokens,
      cache_creation_input_tokens: Tokens,
    })
    .optional(),
});
export type ClaudeResult = z.infer<typeof ClaudeResult>;

/** A field of what the result says it took: one that cannot be read is left out, never an error. */
const kept = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/**
 * What a `result` says the run took (ADR 0172); read apart, so it never fails the result. Its cost
 * is claude's list price, which says nothing of what a user pays, so it is not read (ADR 0181).
 */
export const ClaudeResultReceipt = z.looseObject({
  duration_ms: kept(Tokens),
  duration_api_ms: kept(Tokens),
  modelUsage: kept(
    z.record(
      z.string().regex(/\S/),
      z.looseObject({
        inputTokens: Tokens,
        outputTokens: Tokens,
        cacheReadInputTokens: Tokens,
        cacheCreationInputTokens: Tokens,
      }),
    ),
  ),
});
export type ClaudeResultReceipt = z.infer<typeof ClaudeResultReceipt>;
