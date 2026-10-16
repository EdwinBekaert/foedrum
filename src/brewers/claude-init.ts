// The first check of an attempt's stream (ADR 0045): claude's init event must show the session
// the runner asked for before anything else of the stream is read. claude drops a settings file
// silently, and settings of the user could widen a brewer, so what it set up is checked, not
// trusted. A mismatch is an environment failure, never retried.

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

/** Whether an init event (the stream's first event, parsed) shows the session that was asked. */
export function checkInit(_event: unknown, _asked: AskedSession): InitCheck {
  throw new Error('not implemented');
}
