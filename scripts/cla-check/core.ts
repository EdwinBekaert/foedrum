// Decides whether a pull request's author signed the CLA, from the author's login, the
// repository owner's login and the text of the signatures file at the pull request's head
// (ADR 0391, ADR 0021).

export const SIGNATURES_FILE = '.github/cla-signatures.md';
const CLA_VERSION = '1.0';

// The repository owner, who receives the licence, and Dependabot sign nothing (ADR 0391).
const DEPENDABOT = 'dependabot[bot]';

// One signer: `- @<login>, CLA <version>, <YYYY-MM-DD>`, the whole line. Any version counts.
const SIGNATURE = /^- @([A-Za-z0-9-]+), CLA \d+\.\d+, \d{4}-\d{2}-\d{2}$/;

export interface ClaVerdict {
  ok: boolean;
  line: string;
}

// GitHub logins are not case-sensitive.
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const claCheck = (author: string, owner: string, signatures: string): ClaVerdict => {
  if (sameLogin(author, owner) || sameLogin(author, DEPENDABOT)) {
    return { ok: true, line: `@${author} needs no CLA signature` };
  }
  const signed = signatures
    .split(/\r?\n/)
    .some((line) => sameLogin(SIGNATURE.exec(line.trimEnd())?.[1] ?? '', author));
  return signed
    ? { ok: true, line: `@${author} signed the CLA` }
    : {
        ok: false,
        line:
          `@${author} has not signed the CLA: read CLA.md, then add the line ` +
          `"- @${author}, CLA ${CLA_VERSION}, <YYYY-MM-DD>" to ${SIGNATURES_FILE} in a commit ` +
          'of its own in this pull request.',
      };
};
