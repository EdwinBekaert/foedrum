// What a person does next about a batch that waits for them (ADR 0379): one `Next:` line, which the
// status comment, the plan comment, `foedrum stuck` and `foedrum brew` all show, so every surface
// offers the same options, each as the whole command and what it does.

import type { StuckOption, StuckReason } from '../schemas/events.ts';

/** How a surface writes a command: as code in a comment, as it is on a terminal. */
export type Command = (text: string) => string;

/**
 * The `Next:` line of a batch Stuck for `reason` with `options`, named `called` in its commands
 * (ADR 0329).
 */
export const stuckNext = (
  _reason: StuckReason,
  _options: readonly StuckOption[],
  _called: string,
  _command: Command,
): string => {
  throw new Error('not implemented');
};
