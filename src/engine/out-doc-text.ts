// Out doc text on its way to the pull request body and the status comment (ADR 0088): a text that
// looks like a secret is left out, with a fixed line naming its step. Pure.

import type { IsCommit } from '../formats/secrets.ts';
import type { State } from './fold.ts';

/** `text`, or the fixed line of `stepId` when it looks like a secret. */
export const withoutSecrets = (_text: string, _stepId: string, _isCommit: IsCommit): string => {
  throw new Error('not implemented');
};

/** The commits the state records for `batchId`: a 40-character hexadecimal word that is one is no key. */
export const knownCommits = (_state: State, _batchId: string): IsCommit => {
  throw new Error('not implemented');
};
