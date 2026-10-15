// The batch state machine: the core of the command layer (architecture §4.3, ADR 0019, ADR 0025).
// It takes the folded state and one command, and returns the events to append or a refusal.
// Pure: the caller passes the time, and the recipes through a small interface.

import type {
  Answer,
  Event,
  StuckOption,
  StuckReason,
  Surface,
  Usage,
  WaitCondition,
} from '../schemas/events.ts';
import type { BlockerKind } from '../schemas/out-doc.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import type { Decision } from './admit.ts';
import type { State } from './fold.ts';
import type { RecipeBook } from './recipes.ts';

/** Who issued a human command, and from where (ADR 0019). */
interface Issuer {
  batchId: string;
  by: string;
  via: Surface;
}

/** The commands a human issues, mostly to get a Stuck batch moving again. */
export type HumanCommand =
  | ({ kind: 'retry' } & Issuer)
  | ({ kind: 'skip' } & Issuer)
  | ({ kind: 'answer'; answers: readonly Answer[] } & Issuer)
  | ({ kind: 'recipe'; recipe: string; reason: string } & Issuer)
  /** `shas`: the commit of each repository at `toStepId`, by `owner/name`. */
  | ({ kind: 'rewind'; toStepId: string; shas: Readonly<Record<string, string>> } & Issuer)
  | ({ kind: 'cancel' } & Issuer);

/** How an attempt ended: a step outcome, or a brewer's `blocked` out doc with its blocker kind. */
export type Ending = StepOutcome | { kind: 'blocked'; blockerKind: BlockerKind; summary: string };

/** Events the engine records as they happen; they decide nothing about a batch's lane. */
export type RecordedEvent = Extract<
  Event,
  {
    type:
      | 'batch.ordered'
      | 'step.started'
      | 'order.decomposed'
      | 'bottle.opened'
      | 'release.observed'
      | 'effect.applied';
  }
>;

/** The commands the engine issues itself: the drivers and the supervisor. */
export type EngineCommand =
  | { kind: 'record'; event: RecordedEvent }
  | { kind: 'route'; batchId: string; recipe: string; reason: string; by: 'label' | 'router' }
  | {
      kind: 'finish';
      batchId: string;
      stepId: string;
      attempt: number;
      ending: Ending;
      usage?: Usage;
    }
  /** The supervisor found the attempt past its deadline (invariant I5). */
  | { kind: 'expire'; batchId: string; stepId: string; attempt: number }
  | { kind: 'wait'; batchId: string; on: WaitCondition }
  /** The supervisor found a Conditioning or Stuck reminder due. */
  | { kind: 'remind'; batchId: string };

export type Command = HumanCommand | EngineCommand;

export interface Context {
  now: Date;
  recipes: RecipeBook;
  /** How long a Conditioning or Stuck batch waits before the next reminder, in milliseconds. */
  reminderMs: number;
}

/** The options a Stuck batch offers for `reason`. */
export function stuckOptions(_reason: StuckReason): StuckOption[] {
  throw new Error('not implemented');
}

/** The events `command` appends to `state`, or why it is refused. */
export function decide(_state: State, _command: Command, _context: Context): Decision {
  throw new Error('not implemented');
}
