// `npm run audit:advisories`: npm audit --omit=dev against the advisory endpoint, once per CI run
// (ADR 0119). npm-audit/core.ts reads npm's JSON and decides; this shell runs npm and waits before
// the one retry a failing endpoint gets (ADR 0021). It exits 0 only on a clean report.

import { setTimeout as delay } from 'node:timers/promises';
import { type ExecProcess, whyKilled } from '../src/platform/processes.ts';
import { MAX_TRIES, nextStep, readAudit } from './npm-audit/core.ts';

export type Wait = (ms: number) => Promise<void>;

// Long enough for a load balancer to send the request elsewhere, short against the run.
export const RETRY_WAIT_MS = 30_000;
// Above npm's own fetch-timeout of 300 s, which the outage of #330 ran into, and under the job's.
const NPM_TIMEOUT_MS = 360_000;

export interface AuditRun {
  ok: boolean;
  lines: string[];
}

export const auditAdvisories = async (
  cwd: string,
  env: NodeJS.ProcessEnv,
  execPath: string,
  exec: ExecProcess,
  wait: Wait,
  stop?: AbortSignal,
): Promise<AuditRun> => {
  const npmCli = env.npm_execpath;
  if (npmCli === undefined || npmCli === '') {
    return {
      ok: false,
      lines: ['npm_execpath is not set; run this through npm run audit:advisories'],
    };
  }
  const lines: string[] = [];
  for (let tried = 1; ; tried++) {
    const { exitCode, stdout, stderr, killed } = await exec(
      execPath,
      [npmCli, 'audit', '--omit=dev', '--json'],
      { cwd, timeoutMs: NPM_TIMEOUT_MS, signal: stop },
    );
    if (exitCode === null) {
      const why = whyKilled(killed, NPM_TIMEOUT_MS) ?? 'no exit code';
      const said = stderr.trim() === '' ? [] : [stderr.trim()];
      return { ok: false, lines: [...lines, `npm audit did not finish (${why})`, ...said] };
    }
    const step = nextStep(readAudit(exitCode, stdout), tried);
    if (step.kind !== 'pass' && stderr.trim() !== '') lines.push(stderr.trim());
    lines.push(...step.lines.map((line) => `try ${tried} of ${MAX_TRIES}: ${line}`));
    if (step.kind !== 'retry') return { ok: step.kind === 'pass', lines };
    await wait(RETRY_WAIT_MS);
  }
};

if (import.meta.main) {
  const { execProcess, stopOnSignals } = await import('../src/platform/processes.ts');
  const stop = stopOnSignals();
  try {
    const run = await auditAdvisories(
      process.cwd(),
      process.env,
      process.execPath,
      execProcess,
      (ms) => delay(ms, undefined, { signal: stop }),
      stop,
    );
    for (const line of run.lines) console.log(line);
    process.exitCode = run.ok ? 0 : 1;
  } catch (error) {
    console.log(`audit:advisories failed: ${String(error)}`);
    process.exitCode = 1;
  }
}
