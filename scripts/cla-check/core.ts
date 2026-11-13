// Decides whether a pull request's author signed the CLA, from the author's login, the
// repository owner's login and the text of the signatures file at the pull request's head
// (ADR 0391, ADR 0021).

export const SIGNATURES_FILE = '.github/cla-signatures.md';

export interface ClaVerdict {
  ok: boolean;
  line: string;
}

export const claCheck = (_author: string, _owner: string, _signatures: string): ClaVerdict => {
  throw new Error('not implemented');
};
