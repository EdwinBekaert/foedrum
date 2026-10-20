// npm run demo's walkthrough (#268): the steps it shows, each with a heading and one line that says
// what to look for, when it pauses between them, and how it shows what the Cellar and the code host
// left. The shell is scripts/demo.ts.

import type { ServeInputs } from '../../src/cli/serve-config.ts';
import type { Event } from '../../src/schemas/events.ts';

/** One step of the walkthrough: its heading, and what to look for in it. */
export interface Step {
  id: 'diagnosis' | 'order' | 'brewing' | 'restart' | 'pull-request' | 'on-tap' | 'replay';
  title: string;
  lookFor: string;
}

/** The steps, in the order the walkthrough shows them. */
export const STEPS: readonly Step[] = [];

/** The heading line of `STEPS[index]`. */
export const headingOf = (_index: number): string => {
  throw new Error('not implemented');
};

/** What the walkthrough prints to open `STEPS[index]`: a blank line, its heading, what to look for. */
export const stepLines = (_index: number): string[] => {
  throw new Error('not implemented');
};

/** The line a pause shows while it waits for Enter. */
export const PAUSE_PROMPT = '';

/**
 * Whether the walkthrough pauses between its steps: only when someone can press Enter, on a
 * terminal, and `--no-pause` was not given.
 */
export const pausesBetweenSteps = (_options: {
  noPause: boolean;
  interactive: boolean;
}): boolean => {
  throw new Error('not implemented');
};

/** The diagnosis serve runs with in the demo, as lines. */
export const diagnosisLines = (_diagnosis: ServeInputs['diagnosis']): string[] => {
  throw new Error('not implemented');
};

/** A comment's Markdown without its HTML comments, which GitHub does not show either. */
export const commentMarkdown = (_body: string): string => {
  throw new Error('not implemented');
};

/** The start of the line the Cellar prints when its restart finds the attempt it lost. */
export const LOST_LINE = 'demo: the restart found';

/**
 * The line that says the restart found an attempt lost with the Cellar and started the next one,
 * from the store's events in order; undefined until both are there.
 */
export const lostAttemptLine = (_events: readonly { event: Event }[]): string | undefined => {
  throw new Error('not implemented');
};

/**
 * A process's output in two parts: the lines before the first line `at` matches, and the rest
 * from it; or, with `keep: 'with'`, that line goes with the first part. All of it is the first
 * part when no line matches.
 */
export const splitOutput = (
  _output: string,
  _at: (line: string) => boolean,
  _keep: 'before' | 'with',
): [string[], string[]] => {
  throw new Error('not implemented');
};
