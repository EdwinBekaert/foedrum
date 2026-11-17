// A push the secret scan refused (ADR 0079) waits as a Stuck reason of its own, `push_refused`:
// what was found, by kind, place and line, never the text, and the one question a person answers
// with `foedrum answer <issue> stop` (ADR 0418).

import type { StuckReason } from '../schemas/events.ts';
import type { ScanFinding } from '../schemas/store.ts';

/** The one question a batch whose push was refused asks, which `foedrum answer` answers. */
export const PUSH_REFUSED_QUESTION =
  'The push was refused for what looks like a secret in its commits: stop the batch?';

/** What the push of `commit` would have sent and the scan refused, as the ledger keeps it. */
export interface PushRefusal {
  commit: string;
  findings: readonly ScanFinding[];
}

/** The Stuck reason of the push `refusal` at `stepId`: its first findings, and how many more. */
export const pushRefusedReason = (
  _stepId: string,
  _refusal: PushRefusal,
): Extract<StuckReason, { kind: 'push_refused' }> => {
  throw new Error('not implemented');
};

/** Each finding of `reason` as `<kind> in <place> line <n> of <commit>`, then how many more. */
export const refusedLines = (_reason: Extract<StuckReason, { kind: 'push_refused' }>): string[] => {
  throw new Error('not implemented');
};
