// Out doc text on its way to the pull request body and the status comment (ADR 0088): a text that
// looks like a secret is left out, with a fixed line naming its step. Pure.

import { findSecrets, type IsCommit } from '../formats/secrets.ts';

/**
 * `text`, or a fixed line naming `stepId` when it looks like a secret: never the matched text, nor
 * `findSecrets`' excerpt of it. The text is read as written and as shown, on one line, since
 * joining its lines can make a match (`password` and `= x` on two lines).
 */
export const withoutSecrets = (text: string, stepId: string, isCommit: IsCommit): string => {
  const oneLine = text.replace(/\s+/g, ' ');
  const found = [text, oneLine].some((each) => findSecrets(each, isCommit).length > 0);
  return found ? `[left out: a text of step ${stepId} that looks like a secret]` : text;
};
