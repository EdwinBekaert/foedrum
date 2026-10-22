// Reads what `npm audit --omit=dev --json` answered and decides what CI does next (ADR 0021,
// ADR 0119). npm exits 1 both for findings and when the advisory endpoint fails, so the exit
// code alone cannot tell an outage from a finding: the JSON on stdout can. A clean report counts
// only with exit 0 and a report of no vulnerabilities, so an outage is never read as clean.

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

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parse = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout);
  } catch {
    return undefined;
  }
};

// An advisory in a vulnerability's `via`; a plain string names another vulnerable package.
const advisoryLine = (via: unknown): string | undefined =>
  isObject(via) && typeof via.title === 'string'
    ? typeof via.url === 'string'
      ? `${via.title} (${via.url})`
      : via.title
    : undefined;

const findingsOf = (vulnerabilities: Json): Finding[] =>
  Object.entries(vulnerabilities).map(([name, vulnerability]) => {
    const entry = isObject(vulnerability) ? vulnerability : {};
    const via = Array.isArray(entry.via) ? entry.via : [];
    return {
      name,
      severity: typeof entry.severity === 'string' ? entry.severity : 'unknown severity',
      advisories: via.map(advisoryLine).filter((line) => line !== undefined),
    };
  });

export const readAudit = (exitCode: number, stdout: string): AuditResult => {
  const json = parse(stdout);
  if (!isObject(json)) return { kind: 'unreadable', reason: 'stdout is not a JSON object' };
  if (isObject(json.vulnerabilities)) {
    const findings = findingsOf(json.vulnerabilities);
    if (exitCode === 0 && findings.length === 0) return { kind: 'clean' };
    if (exitCode !== 0 && findings.length > 0) return { kind: 'findings', findings };
    return {
      kind: 'unreadable',
      reason: `exit ${exitCode} with ${findings.length} vulnerable packages in the report`,
    };
  }
  // npm's audit-error.js: the request's message, and its status when an answer came.
  if (exitCode !== 0 && typeof json.message === 'string') {
    const statusCode = typeof json.statusCode === 'number' ? json.statusCode : undefined;
    return { kind: 'endpoint-error', statusCode, message: json.message };
  }
  return { kind: 'unreadable', reason: `exit ${exitCode} with neither a report nor an error` };
};

// A server error or no answer may be an outage that passes; a client error will not.
const mayPass = (statusCode: number | undefined): boolean =>
  statusCode === undefined || statusCode >= 500;

// What to do after `attempt` (1-based) answered `result`.
export const nextStep = (result: AuditResult, attempt: number): NextStep => {
  switch (result.kind) {
    case 'clean':
      return { kind: 'pass', lines: ['no advisories for the runtime dependencies'] };
    case 'findings':
      return {
        kind: 'fail',
        lines: [
          `${result.findings.length} vulnerable runtime packages; run npm audit --omit=dev for the report`,
          ...result.findings.flatMap(({ name, severity, advisories }) => [
            `${name} (${severity})`,
            ...advisories.map((advisory) => `  ${advisory}`),
          ]),
        ],
      };
    case 'endpoint-error': {
      const what = `the advisory endpoint failed: ${result.message}`;
      if (!mayPass(result.statusCode)) return { kind: 'fail', lines: [what] };
      return attempt < MAX_ATTEMPTS
        ? { kind: 'retry', lines: [`${what}; trying again`] }
        : {
            kind: 'fail',
            lines: [`${what}, ${attempt} times; an outage is not a clean report, run CI again`],
          };
    }
    case 'unreadable':
      return { kind: 'fail', lines: [`cannot read npm audit's answer: ${result.reason}`] };
    default: {
      const never: never = result;
      return never;
    }
  }
};
