// A push the secret scan refused (ADR 0079) waits as a Stuck reason of its own, `push_refused`:
// what was found, by kind, place and line, never the text, and the one question a person answers
// with `foedrum answer <issue> stop` (ADR 0418) or `foedrum answer <issue> allow "<why>"`, which
// lets the push of that exact commit go (ADR 0419).

import { MOST_REFUSED_SHOWN, type StuckReason } from '../schemas/events.ts';
import type { ScanFinding } from '../schemas/store.ts';

/** The one question a batch whose push was refused asks, which `foedrum answer` answers. */
export const PUSH_REFUSED_QUESTION =
  'The push was refused for what looks like a secret in its commits: allow the push of this commit, or stop the batch?';

/** What the push of `commit` would have sent and the scan refused, as the ledger keeps it. */
export interface PushRefusal {
  commit: string;
  findings: readonly ScanFinding[];
}

/** The Stuck reason of the push `refusal` at `stepId`: its first findings, and how many more. */
export const pushRefusedReason = (
  stepId: string,
  { commit, findings }: PushRefusal,
): Extract<StuckReason, { kind: 'push_refused' }> => ({
  kind: 'push_refused',
  stepId,
  commit,
  findings: findings.slice(0, MOST_REFUSED_SHOWN),
  more: Math.max(0, findings.length - MOST_REFUSED_SHOWN),
});
