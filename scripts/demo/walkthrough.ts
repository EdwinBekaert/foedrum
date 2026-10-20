// npm run demo's walkthrough (#268): the steps it shows, each with a heading and one line that says
// what to look for, when it pauses between them, and how it shows what the Cellar and the code host
// left. The shell is scripts/demo.ts.

import { columns } from '../../src/cli/columns.ts';
import type { ServeInputs } from '../../src/cli/serve-config.ts';
import type { Event } from '../../src/schemas/events.ts';

/** The demo's one batch: its order is the Brewery's first issue, decomposed into one batch. */
export const BATCH = '1-1';

/** One step of the walkthrough: its heading, and what to look for in it. */
export interface Step {
  id: 'diagnosis' | 'order' | 'brewing' | 'restart' | 'pull-request' | 'on-tap' | 'replay';
  title: string;
  lookFor: string;
}

/** The steps, in the order the walkthrough shows them. */
export const STEPS: readonly Step[] = [
  {
    id: 'diagnosis',
    title: 'The diagnosis serve runs with',
    lookFor:
      "this is the demo's own diagnosis, not foedrum doctor on this machine: the demo starts no claude and no gh, so it checks neither.",
  },
  {
    id: 'order',
    title: 'The order comes in',
    lookFor:
      'an issue in the Brewery, labelled for its recipe by a user it lists, is all serve needs to take it as a batch.',
  },
  {
    id: 'brewing',
    title: 'foedrum status as the batch moves',
    lookFor:
      'the batch goes from the order to brewing, and brew #1 is started when the Cellar is killed.',
  },
  {
    id: 'restart',
    title: 'The kill and the restart',
    lookFor:
      'the restart finds brew #1 lost with the killed Cellar, and brews it again as brew #2.',
  },
  {
    id: 'pull-request',
    title: 'The pull request and the status comment',
    lookFor:
      'one pull request and one status comment on the fake code host, though the Cellar lived twice.',
  },
  {
    id: 'on-tap',
    title: 'On tap',
    lookFor: 'foedrum status shows the batch on tap, with its pull request.',
  },
  {
    id: 'replay',
    title: `foedrum replay ${BATCH}`,
    lookFor: 'every event the batch went through, and the state the fold makes of them.',
  },
];

/** The heading line of `STEPS[index]`. */
export const headingOf = (index: number): string =>
  `Step ${index + 1} of ${STEPS.length}: ${STEPS[index]?.title}`;

/** What the walkthrough prints to open `STEPS[index]`: a blank line, its heading, what to look for. */
export const stepLines = (index: number): string[] => [
  '',
  headingOf(index),
  `Look for: ${STEPS[index]?.lookFor}`,
];

/** The line a pause shows while it waits for Enter. */
export const PAUSE_PROMPT =
  'Press Enter for the next step (npm run demo -- --no-pause runs without the pauses) ';

/**
 * Whether the walkthrough pauses between its steps: only when someone can press Enter, on a
 * terminal, and `--no-pause` was not given.
 */
export const pausesBetweenSteps = (options: { noPause: boolean; interactive: boolean }): boolean =>
  options.interactive && !options.noPause;

/** The diagnosis serve runs with in the demo, as lines. */
export const diagnosisLines = (diagnosis: ServeInputs['diagnosis']): string[] => {
  const { tools, isolation, problems } = diagnosis;
  const said = problems.map(({ what, fix }) => `${what}: ${fix}`);
  return columns([
    ...tools.map(({ name, version, path }) => [
      name,
      [version, path].filter((part) => part !== undefined).join(' '),
    ]),
    ['isolation', `${isolation.level}: ${isolation.why}`],
    ...(said.length === 0
      ? [['problems', 'none']]
      : said.map((line, i) => [i === 0 ? 'problems' : '', line])),
  ]);
};

/** A comment's Markdown without its HTML comments, which GitHub does not show either. */
export const commentMarkdown = (body: string): string =>
  body.replace(/<!--[\s\S]*?-->/g, '').trimEnd();

/** The start of the line the Cellar prints when its restart finds the attempt it lost. */
export const LOST_LINE = 'demo: the restart found';

/**
 * The line that says the restart found an attempt lost with the Cellar and started the next one,
 * from the store's events in order; undefined until both are there.
 */
export const lostAttemptLine = (events: readonly { event: Event }[]): string | undefined => {
  const lost = new Map<string, { attempt: number; reason: string }>();
  for (const { event } of events) {
    if (event.type !== 'step.finished' && event.type !== 'step.started') continue;
    const step = `${event.batchId} ${event.stepId}`;
    if (event.type === 'step.finished') {
      const { outcome } = event;
      if (outcome.kind === 'failed' && outcome.reason.startsWith('the attempt was lost')) {
        lost.set(step, { attempt: event.attempt, reason: outcome.reason });
      }
      continue;
    }
    const before = lost.get(step);
    if (before !== undefined && event.attempt === before.attempt + 1) {
      const { stepId } = event;
      return `${LOST_LINE} ${stepId} #${before.attempt} lost (${before.reason}); ${stepId} #${event.attempt} brews it again`;
    }
  }
  return undefined;
};

/**
 * A process's output in two parts: the lines before the first line `at` matches, and the rest
 * from it; or, with `keep: 'with'`, that line goes with the first part. All of it is the first
 * part when no line matches.
 */
export const splitOutput = (
  output: string,
  at: (line: string) => boolean,
  keep: 'before' | 'with',
): [string[], string[]] => {
  const lines = output.trimEnd() === '' ? [] : output.trimEnd().split(/\r?\n/);
  const found = lines.findIndex(at);
  if (found === -1) return [lines, []];
  const cut = keep === 'with' ? found + 1 : found;
  return [lines.slice(0, cut), lines.slice(cut)];
};
