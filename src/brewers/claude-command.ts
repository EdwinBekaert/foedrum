// The `claude` command line of a brewer attempt (ADR 0042, ADR 0046). The prompt is not part of
// it: it goes on stdin, so the line stays short enough for the Job Object helper (ADR 0039).

import type { BrewerFrontmatter } from '../schemas/brewer.ts';
import { ModelId } from '../schemas/models.ts';

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

const toolName = /^[A-Za-z][A-Za-z0-9_-]*$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` is a session id claude takes: a UUID. */
export const isSessionId = (id: string): boolean => uuid.test(id);

// The values come from validated brewers and the runner itself, so a bad one is a defect; it
// must never reach cmd.exe for npm's claude.cmd (ADR 0031) or read as an option.
const refuse = (what: string, value: unknown): never => {
  throw new Error(`claude ${what} is not valid: ${JSON.stringify(value)}`);
};

/** An attempt's session as an engineer opens it (ADR 0126): its model and guards, interactive. */
export interface ResumeCall {
  model: string;
  effort: BrewerFrontmatter['effort'];
  settingsFile: string;
  tools: readonly string[];
  sessionId: string;
}

/** The arguments of an interactive `claude` that resumes an attempt's session. */
export function resumeArgs(call: ResumeCall): string[] {
  const { model, effort, settingsFile, tools, sessionId } = call;
  checkCall(model, tools, sessionId);
  // No print-mode flag and no permission mode: the engineer answers what the settings do not allow.
  return [
    '--resume',
    sessionId,
    '--model',
    model,
    '--effort',
    effort,
    ...guards(settingsFile, tools),
  ];
}

// The checks every command line's values pass.
const checkCall = (model: string, tools: readonly string[], sessionId: string): void => {
  if (!ModelId.safeParse(model).success) refuse('model', model);
  if (tools.length === 0 || !tools.every((tool) => toolName.test(tool))) refuse('tools', tools);
  if (!isSessionId(sessionId)) refuse('session id', sessionId);
};

// The guards of an attempt's session, however it runs.
const guards = (settingsFile: string, tools: readonly string[]): string[] => [
  '--settings',
  settingsFile,
  // No user, project or local settings file: only --settings, which is the runner's (ADR 0046).
  '--setting-sources',
  '',
  '--tools',
  tools.join(','),
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--safe-mode',
];

/** The arguments of `claude` for one attempt. */
export function claudeArgs(call: ClaudeCall): string[] {
  const { model, effort, maxTurns, settingsFile, tools, session } = call;
  checkCall(model, tools, session.id);
  if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0)) {
    refuse('maxTurns', maxTurns);
  }
  return [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--model',
    model,
    '--effort',
    effort,
    ...(maxTurns === undefined ? [] : ['--max-turns', String(maxTurns)]),
    ...guards(settingsFile, tools),
    ...(session.kind === 'new' ? ['--session-id', session.id] : ['--resume', session.id]),
    ...(call.appendSystemPromptFile === undefined
      ? []
      : ['--append-system-prompt-file', call.appendSystemPromptFile]),
  ];
}
