// What a person does next about a batch that waits for them (ADR 0379): one `Next:` line, which the
// status comment, the plan comment, `foedrum stuck` and `foedrum brew` all show, so every surface
// offers the same options, each as the whole command and what it does.

import type { StuckOption, StuckReason } from '../schemas/events.ts';

/** How a surface writes a command: as code in a comment, as it is on a terminal. */
export type Command = (text: string) => string;

/** `a`, `a or b`, `a, b, or c`. */
const either = (parts: readonly string[]): string =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, or ${parts.at(-1)}`;

/** One option of a batch Stuck for `reason`, as what it does and its command. */
const optionText = (
  option: Exclude<StuckOption, 'answer'>,
  reason: StuckReason,
  called: string,
  command: Command,
): string => {
  const run = (rest = '') => command(`foedrum ${option} ${called}${rest}`);
  switch (option) {
    case 'approve':
      return `sign it off with ${run()}`;
    case 'lauter':
      return `correct it with the Brewmaster in a session with ${run()}`;
    case 'retry':
      return reason.kind === 'plan_review'
        ? `plan it again with ${run()}`
        : `try the step again with ${run()}`;
    case 'skip':
      return `go past the step with ${run()}`;
    case 'recipe':
      return `brew the issue with another recipe with ${run(' <recipe> <reason>')}`;
    case 'rewind':
      return `take it back to an earlier step with ${run(' <step>')}`;
    case 'cancel':
      return `end it with ${run()}`;
    default:
      return option satisfies never;
  }
};

/**
 * The `Next:` line of a batch Stuck for `reason` with `options`, named `called` in its commands
 * (ADR 0329).
 */
export const stuckNext = (
  reason: StuckReason,
  options: readonly StuckOption[],
  called: string,
  command: Command,
): string => {
  const others = options.flatMap((option) =>
    option === 'answer' ? [] : [optionText(option, reason, called, command)],
  );
  switch (reason.kind) {
    case 'plan_review':
      return `Next: read the plan and its assumptions, then ${either(others)}.`;
    case 'needs_input': {
      const answers = reason.questions.map((_, n) => `<answer ${n + 1}>`).join(' ');
      const answer = `answer the questions above with ${command(`foedrum answer ${called} ${answers}`)}`;
      return `Next: ${either([answer, ...others])}.`;
    }
    // The one question of an issue that changed since its approval (ADR 0368).
    case 'order_changed': {
      const answer = (word: string) => command(`foedrum answer ${called} ${word}`);
      return `Next: answer ${answer('continue')} to brew the issue as it is now, or ${answer('stop')} to end the batch.`;
    }
    default:
      return `Next: look at what failed above, then ${either(others)}.`;
  }
};
