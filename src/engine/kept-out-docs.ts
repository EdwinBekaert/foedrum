// Keeps the out doc text an attempt's runner read in the store as the attempt ends, before the
// driver records its step.finished, so the next flush puts both on the state branch (ADR 0103).

import type { AttemptRef } from './attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from './brewer-runner.ts';
import type { EventStore } from './event-store.ts';
import { handoverOf } from './handover.ts';

export interface KeepOutDocsOptions {
  runner: BrewerRunner;
  store: Pick<EventStore, 'withTransaction'>;
  /** Told when an out doc could not be kept; the attempt's end goes on without it. */
  report?: (error: unknown, ref: AttemptRef) => void;
}

/**
 * `runner`, whose attempts' out docs are kept in their own transaction before their ends settle:
 * the driver records the step.finished after it, so a flush that has the event has the doc too.
 * The end goes on without the text, which no notice or command should carry, with what the text
 * handed over, each line read for a secret, which only this can still read (ADR 0340).
 */
export function keepOutDocs({
  runner,
  store,
  report = () => {},
}: KeepOutDocsOptions): BrewerRunner {
  const keep = ({ outDoc, ...end }: AttemptEnd, ref: AttemptRef): AttemptEnd => {
    if (outDoc === undefined) return end;
    const handover = handoverOf(outDoc, ref.stepId);
    try {
      store.withTransaction((tx) => tx.keepOutDoc({ ...ref, text: outDoc }));
    } catch (error) {
      // A doc the store cannot take must not cost the attempt its outcome.
      report(error, ref);
    }
    return handover.length === 0 ? end : { ...end, handover };
  };
  return {
    start: (attempt) => {
      const running = runner.start(attempt);
      const ended = running.ended.then((end) => keep(end, attempt.ref));
      return { ended, stop: () => running.stop() };
    },
    progress: (ref) => runner.progress(ref),
  };
}
