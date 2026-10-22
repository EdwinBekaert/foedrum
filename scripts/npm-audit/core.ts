// Reads what `npm audit --omit=dev --json` answered and decides what CI does next (ADR 0021,
// ADR 0119). npm exits 1 both for findings and when the advisory endpoint fails, so the exit
// code alone cannot tell an outage from a finding: the JSON on stdout can.

export interface Finding {
  name: string;
  severity: string;
  // The advisories' titles and links, one line each.
  advisories: string[];
}

export type AuditResult =
  | { kind: 'clean' }
  | { kind: 'findings'; findings: Finding[] }
  // The endpoint failed: `statusCode` is undefined when no answer came at all.
  | { kind: 'endpoint-error'; statusCode: number | undefined; message: string }
  | { kind: 'unreadable'; reason: string };

export type NextStep =
  | { kind: 'pass'; lines: string[] }
  | { kind: 'retry'; lines: string[] }
  | { kind: 'fail'; lines: string[] };

export const MAX_ATTEMPTS = 2;

export const readAudit = (_exitCode: number, _stdout: string): AuditResult => {
  throw new Error('not implemented');
};

// What to do after `attempt` (1-based) answered `result`.
export const nextStep = (_result: AuditResult, _attempt: number): NextStep => {
  throw new Error('not implemented');
};
