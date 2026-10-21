// Keeps the out doc text an attempt's runner read in the store as the attempt ends, before the
// driver records its step.finished, so the next flush puts both on the state branch (ADR 0103).

import type { BrewerRunner } from './brewer-runner.ts';
import type { EventStore } from './event-store.ts';

export interface KeepOutDocsOptions {
  runner: BrewerRunner;
  store: Pick<EventStore, 'withTransaction'>;
  /** Told when an out doc could not be kept; the attempt's end goes on without it. */
  report?: (error: unknown, ref: { batchId: string; stepId: string; attempt: number }) => void;
}

export function keepOutDocs(_options: KeepOutDocsOptions): BrewerRunner {
  throw new Error('not implemented');
}
