// The CLA check CI runs on a pull request (ADR 0391). cla-check/core.ts decides; this shell reads
// the author and the repository owner from the environment the job sets from the event payload,
// and the signatures file at the pull request's head (ADR 0021).

import type { ClaVerdict } from './cla-check/core.ts';

// The file's text, or undefined when it is missing.
export type ReadText = (path: string) => string | undefined;

export const runClaCheck = (_env: NodeJS.ProcessEnv, _readText: ReadText): ClaVerdict => {
  throw new Error('not implemented');
};
