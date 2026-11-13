// The CLA check CI runs on a pull request (ADR 0391). cla-check/core.ts decides; this shell reads
// the author and the repository owner from the environment the job sets from the event payload,
// and the signatures file at the pull request's head (ADR 0021).

import { readFileSync } from 'node:fs';
import { type ClaVerdict, claCheck, SIGNATURES_FILE } from './cla-check/core.ts';

// The file's text, or undefined when it is missing.
export type ReadText = (path: string) => string | undefined;

export const runClaCheck = (env: NodeJS.ProcessEnv, readText: ReadText): ClaVerdict => {
  const author = env.CLA_AUTHOR;
  const owner = env.CLA_OWNER;
  if (author === undefined || author === '' || owner === undefined || owner === '') {
    return { ok: false, line: 'CLA_AUTHOR and CLA_OWNER must be set by the CI job' };
  }
  const signatures = readText(SIGNATURES_FILE);
  if (signatures === undefined) {
    return { ok: false, line: `${SIGNATURES_FILE} could not be read at the pull request's head` };
  }
  return claCheck(author, owner, signatures);
};

if (import.meta.main) {
  const readText: ReadText = (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  const verdict = runClaCheck(process.env, readText);
  console.log(verdict.line);
  process.exitCode = verdict.ok ? 0 : 1;
}
