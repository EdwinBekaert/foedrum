// `npm run audit:advisories`: npm audit --omit=dev against the advisory endpoint, once per CI run
// (ADR 0119). npm-audit/core.ts reads npm's JSON and decides; this shell runs npm and waits before
// the one retry a failing endpoint gets (ADR 0021). It exits 0 only on a clean report.

import type { ExecProcess } from '../src/platform/processes.ts';

export type Wait = (ms: number) => Promise<void>;

// Long enough for a load balancer to send the request elsewhere, short against the run.
export const RETRY_WAIT_MS = 30_000;

export interface AuditRun {
  ok: boolean;
  lines: string[];
}

export const auditAdvisories = async (
  _cwd: string,
  _env: NodeJS.ProcessEnv,
  _execPath: string,
  _exec: ExecProcess,
  _wait: Wait,
  _stop?: AbortSignal,
): Promise<AuditRun> => {
  throw new Error('not implemented');
};
