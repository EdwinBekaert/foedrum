// The `claude` command line of a brewer attempt (ADR 0042, ADR 0045). The prompt is not part of
// it: it goes on stdin, so the line stays short enough for the Job Object helper (ADR 0039).

import type { BrewerFrontmatter } from '../schemas/brewer.ts';

/** A session the attempt starts with the id the runner chose, or one it resumes. */
export type ClaudeSession = { kind: 'new'; id: string } | { kind: 'resume'; id: string };

export interface ClaudeCall {
  /** The model id behind the brewer's alias (models.jsonc). */
  model: string;
  effort: BrewerFrontmatter['effort'];
  maxTurns?: number | undefined;
  /** The attempt's settings file, written by the runner. */
  settingsFile: string;
  /** The built-in tools the brewer may use; no other tool exists in its session. */
  tools: readonly string[];
  session: ClaudeSession;
  /** A system prompt file appended to Claude Code's own. */
  appendSystemPromptFile?: string | undefined;
}

/** The arguments of `claude` for one attempt. */
export function claudeArgs(_call: ClaudeCall): string[] {
  throw new Error('not implemented');
}
