// `foedrum resume` on a running batch (ADR 0127): the interactive driver of that batch, on the
// wiring `foedrum serve` and `foedrum brew` share, under an owner of its own. It takes the batch
// over for the step whose session it continues (ADR 0124's takeover, naming the step, so the
// driver that held it stops its run there), drives the batch until the attempt that continues
// the session has ended (the shell's runner runs it in the foreground, resume-main.ts), and lets
// the batch go, so the driver that takes it next goes on from the next step.

import {
  holdBatch,
  defaultLeaseMs as leaseMs,
  releaseBatch,
  takeOver,
} from '../engine/batch-leases.ts';
import { createCommandLog } from '../engine/command-log.ts';
import { type Batch, latestAttempt } from '../engine/fold.ts';
import { StateBranchStopError } from '../engine/state-branch.ts';
import type { Surface } from '../schemas/events.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import { drivenBy, oneLine } from './brew.ts';
import { closeOpened, messageOf, type Opened, wireDriver } from './driver-wiring.ts';
import { printable } from './run.ts';
import { formatNotice, INTERVAL_MS, type ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';
import { describeLane } from './status.ts';

/** The step of a running batch whose session `foedrum resume` continues, as whom, and who asked. */
export interface RunningResume {
  batchId: string;
  stepId: string;
  /** The driver's owner: its lock's and its leases' (ADR 0037). */
  owner: string;
  by: string;
  via: Surface;
}

/** How an attempt ended, in a few words. */
const endedAs = (outcome: StepOutcome): string => {
  switch (outcome.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return `failed: ${outcome.reason}`;
    case 'needs_input':
      return 'needs input';
    case 'cancelled':
      return 'was cancelled';
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled outcome ${JSON.stringify(unhandled)}`);
    }
  }
};

/** The attempt of `stepId` that continues the session: the one waiting, or the one after the run. */
const resumedAttempt = (batch: Batch | undefined, stepId: string): number => {
  const step = batch?.steps.get(stepId);
  const latest = step && latestAttempt(step);
  if (latest === undefined) return 1;
  return latest.phase === 'scheduled' ? latest.attempt : latest.attempt + 1;
};

/**
 * The step's latest attempt when the step's run is over for resume (ADR 0127): the attempt that
 * continues the session has ended, or the run before it ended by itself, not by the stop, so no
 * attempt will continue its session. Undefined while it waits or runs.
 */
const ranOut = (
  batch: Batch | undefined,
  stepId: string,
  attempt: number,
): { attempt: number; outcome: StepOutcome } | undefined => {
  const step = batch?.steps.get(stepId);
  if (step === undefined) return undefined;
  // Its end may have scheduled a retry, the next driver's to start.
  const resumed = step.attempts.get(attempt);
  if (resumed?.phase === 'finished') return { attempt, outcome: resumed.outcome };
  const latest = latestAttempt(step);
  if (latest?.phase !== 'finished') return undefined;
  const { outcome } = latest;
  // The stop's own end schedules the retry that continues the session, or leaves the batch Stuck.
  if (latest.attempt < attempt && outcome.kind === 'cancelled') return undefined;
  return { attempt: latest.attempt, outcome };
};

/** Takes the batch over, drives it until the resumed attempt ended, and lets it go; 0 when it did. */
export const runResumeRunning = async (
  setup: ServeSetup,
  shell: ServeShell,
  request: RunningResume,
): Promise<number> => {
  const { out, signal, clock, wait, intervalMs = INTERVAL_MS } = shell;
  const { batchId, stepId, owner, by, via } = request;
  // Notices may carry text a model wrote: one line each, as brew's (ADR 0123).
  const say = (line: string): void => out(oneLine(printable(`foedrum resume: ${line}`)));
  let lock: Opened['lock'];
  try {
    lock = shell.lock(setup.workRoot, { brewery: setup.brewery, owner });
  } catch (error) {
    say(messageOf(error));
    return 1;
  }
  const opened: Opened = { lock };
  // The attempt that continues the session, once the log is read, and the state as it is now.
  let attempt = 0;
  let now: (() => Batch | undefined) | undefined;
  try {
    const { store, driver } = await wireDriver(setup, shell, opened, {
      takes: (id) => id === batchId,
      drivesOn: () => false,
      // The batch's retries and answers continue their sessions, whatever the brewer's retryMode:
      // the engineer took it over to continue one.
      resumes: (ref) => ref.batchId === batchId,
      // Nothing more once the step's run is over: in the pass that records its end, the next
      // attempt is the batch's next driver's to start (ADR 0127).
      holds: (id) => id !== batchId || ranOut(now?.(), stepId, attempt) === undefined,
      say,
      report: (notice) => say(formatNotice(notice)),
    });
    const log = createCommandLog({ store, recipes: setup.recipes });
    const heldElsewhere = () =>
      store
        .batchLeases(clock())
        .find((lease) => lease.batchId === batchId && lease.owner !== owner);
    now = () => driver.state().batches.get(batchId);
    attempt = resumedAttempt(log.state().batches.get(batchId), stepId);
    const label = `${stepId}#${attempt}`;
    try {
      // The driver that holds the batch stops its run of the step at its next tick (ADR 0127). A
      // lease that lapsed meanwhile leaves nothing to take over: the driver holds it at its tick.
      const handover = { batchId, owner, by, via, now: clock(), leaseMs, resumes: stepId };
      const decision = takeOver(log, handover);
      const [handed] = decision.kind === 'accepted' ? decision.events : [];
      if (handed?.type === 'batch.taken_over') {
        say(`took batch ${batchId} over from ${handed.from} to resume step ${stepId}`);
      } else if (
        decision.kind === 'refused' &&
        store.batchLeases(clock()).some((lease) => lease.batchId === batchId)
      ) {
        say(decision.reason);
        return 1;
      }
      for (;;) {
        // Held from the takeover on, also before the driver claims it for an attempt or an effect.
        store.withTransaction((tx) => holdBatch(tx, { batchId, owner, now: clock(), leaseMs }));
        try {
          await driver.tick();
        } catch (error) {
          if (error instanceof StateBranchStopError) throw error;
          say(formatNotice({ kind: 'tick_failed', error }));
        }
        const batch = driver.state().batches.get(batchId) as Batch;
        const resumed = batch.steps.get(stepId)?.attempts.get(attempt);
        const { lane, detail } = describeLane(batch);
        const where = `batch ${batchId} is ${lane}${detail === '' ? '' : `: ${detail}`}`;
        if (resumed?.phase === 'finished') {
          const next =
            batch.lane.kind === 'brewing'
              ? `batch ${batchId} goes on from its next step under the driver that takes it`
              : where;
          say(`${label} ${endedAs(resumed.outcome)}; ${next}`);
          return 0;
        }
        const ended = ranOut(batch, stepId, attempt);
        if (ended !== undefined && ended.attempt < attempt) {
          const { attempt: n, outcome } = ended;
          say(`${stepId}#${n} ${endedAs(outcome)} before it was stopped; nothing was resumed`);
          return 1;
        }
        if (batch.lane.kind !== 'brewing' && batch.lane.kind !== 'ordered') {
          const left = resumed === undefined || resumed.phase === 'scheduled';
          say(`${where}; ${left ? 'nothing was resumed' : `${label} was left with it`}`);
          return 1;
        }
        const other = heldElsewhere();
        if (other !== undefined) {
          say(drivenBy(other));
          return 1;
        }
        if (signal.aborted) break;
        await wait(intervalMs, signal);
        if (signal.aborted) break;
      }
      say(`stopped; batch ${batchId} is left for the driver that takes it`);
      return 1;
    } finally {
      // At once for the driver that takes it next, rather than when its lease expires.
      store.withTransaction((tx) => releaseBatch(tx, batchId, owner));
    }
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      say('stopped');
      return 1;
    }
    say(messageOf(error));
    return 1;
  } finally {
    closeOpened(opened);
  }
};
