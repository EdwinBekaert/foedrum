// The first check of an attempt's stream (ADR 0046): claude's init event must show the session
// the runner asked for before anything else of the stream is read. claude drops a settings file
// silently, and settings of the user could widen a brewer, so what it set up is checked, not
// trusted. A mismatch is an environment failure, never retried.

import { ClaudeInit } from '../schemas/claude-stream.ts';

/** What the runner asked claude for. */
export interface AskedSession {
  sessionId: string;
  /** The built-in tools passed with --tools. */
  tools: readonly string[];
}

/** What the runner records of a session that matches. */
export interface SessionFacts {
  sessionId: string;
  /** The full model id. */
  model: string;
  claudeVersion: string;
}

export type InitCheck =
  | { kind: 'matches'; session: SessionFacts }
  | { kind: 'mismatch'; reason: string };

const names = (list: readonly unknown[]): string =>
  list.map((item) => JSON.stringify(item)).join(', ');

/** Whether an init event (the stream's first event, parsed) shows the session that was asked. */
export function checkInit(event: unknown, asked: AskedSession): InitCheck {
  const read = ClaudeInit.safeParse(event);
  // Fail closed: what cannot be read cannot be shown to match.
  if (!read.success)
    return {
      kind: 'mismatch',
      reason: 'the stream does not start with an init event claude must send',
    };
  const init = read.data;
  const problems: string[] = [];
  if (init.session_id !== asked.sessionId) {
    problems.push(
      `session ${JSON.stringify(init.session_id)}, not ${JSON.stringify(asked.sessionId)}`,
    );
  }
  if (init.permissionMode !== 'dontAsk') {
    problems.push(`permission mode ${JSON.stringify(init.permissionMode)}, not dontAsk`);
  }
  // MCP tools included: the brewer has no MCP server, so an mcp__ tool is one too many.
  const extra = init.tools.filter((tool) => !asked.tools.includes(tool));
  if (extra.length > 0) problems.push(`tools not asked for: ${names(extra)}`);
  const missing = asked.tools.filter((tool) => !init.tools.includes(tool));
  if (missing.length > 0) problems.push(`tools asked for but missing: ${names(missing)}`);
  if (init.mcp_servers.length > 0) {
    problems.push(`MCP servers: ${names(init.mcp_servers.map((server) => server.name))}`);
  }
  if (init.skills.length > 0) problems.push(`skills: ${names(init.skills)}`);
  if (init.slash_commands.length > 0)
    problems.push(`slash commands: ${names(init.slash_commands)}`);
  if (problems.length > 0) return { kind: 'mismatch', reason: problems.join('; ') };
  return {
    kind: 'matches',
    session: {
      sessionId: init.session_id,
      model: init.model,
      claudeVersion: init.claude_code_version,
    },
  };
}
