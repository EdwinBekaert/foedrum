// npm run demo's walkthrough (#268): the steps it shows, each with a heading and one line that says
// what to look for, when it pauses between them, and how it shows what the Cellar and the code host
// left. The shell is scripts/demo.ts.

import { columns } from '../../src/cli/columns.ts';
import type { ServeInputs } from '../../src/cli/serve-config.ts';
import type { Event } from '../../src/schemas/events.ts';
import { BREW_ORDER, USER } from './core.ts';

/** The Cellar's batch: its order is the Brewery's first issue, decomposed into one batch. */
export const BATCH = '1-1';
/** The attempt foedrum resume names: the Cellarman's second, the one the failed check sent back. */
export const RESUMED = 'implement#2';

/** One step of the walkthrough: its heading, and what to look for in it. */
export interface Step {
  id:
    | 'diagnosis'
    | 'order'
    | 'brewing'
    | 'restart'
    | 'checks'
    | 'pull-request'
    | 'on-tap'
    | 'lenses'
    | 'brew'
    | 'resume'
    | 'replay';
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
      "an issue in the Brewery, labelled recipe:nip-parallel by a user it lists, is all serve needs to take it as a batch for the Brewery's own recipe: Nip's steps from Foedrum's defaults, with its taste step a parallel group of three lenses.",
  },
  {
    id: 'brewing',
    title: 'foedrum status as the batch moves',
    lookFor:
      "the batch goes from the order to brewing, and the Gauger's gauge #1 has committed a failing test when the Cellar is killed.",
  },
  {
    id: 'restart',
    title: 'The kill and the restart',
    lookFor:
      'the restart finds gauge #1 lost with the killed Cellar, and brews it again as gauge #2.',
  },
  {
    id: 'checks',
    title: 'The red proof and the failed check',
    lookFor:
      "red #1 must see the Gauger's test fail before implement #1 may start; green #1 fails the Cellarman's first fix, so implement #2 starts, told why, with the failed test's own line; once green #2 passes, foedrum status shows the Tasters' correctness #1, security #1 and test-design #1 brewing at once. correctness #1 blocks with one finding, so once all three have ended the batch goes back to implement #3, told that finding; then correctness #2, security #2 and test-design #2 are told the change since round 1 and round 1's findings, the Cellarman's marked fixed, and correctness #2 approves.",
  },
  {
    id: 'pull-request',
    title: 'The pull request and the status comment',
    lookFor:
      "one pull request and one status comment on the fake code host, though the Cellar lived twice; its path line has both rounds, the three lens attempts side by side in each with implement #3 between them, and its Findings each one's findings under its own step.",
  },
  {
    id: 'on-tap',
    title: 'On tap',
    lookFor: 'foedrum status shows the batch on tap, with its pull request.',
  },
  {
    id: 'lenses',
    title: 'foedrum lenses',
    lookFor:
      "each lens with its rounds, its findings by severity and how they ended, and its tokens: correctness's one finding is fixed, which only the round it blocked recorded; security and test-design each left one minor finding open, and diff/acceptance, a lens of Nip's that this Brewery's recipe does not run, has no rounds.",
  },
  {
    id: 'brew',
    title: `foedrum brew ${BREW_ORDER.number} --as ${USER}`,
    lookFor: `the same order again as issue #${BREW_ORDER.number}, brewed from a terminal instead of the Cellar: foedrum brew orders it, routes it by its label, and drives that one batch to its pull request.`,
  },
  {
    id: 'resume',
    title: `foedrum resume ${BATCH} ${RESUMED}`,
    lookFor:
      "resume finds the Cellarman's session of that attempt and prints the line that opens it in its worktree in a terminal; the demo opens it nowhere, since it starts no claude.",
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
export const pausesBetweenSteps = (options: {
  noPause: boolean;
  interactive: boolean;
  /** The input ended at a pause (Ctrl+D): no one can press Enter any more. */
  inputEnded?: boolean;
}): boolean => options.interactive && !options.noPause && options.inputEnded !== true;

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

/** The line the Cellar prints before each `foedrum status` it shows. */
export const STATUS_LINE = '$ foedrum status';

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

/** The prompt's route input begins with where it came from (ADR 0128). */
const ROUTE_SOURCE = /why step \S+ runs again: [^"\n]*/;

/**
 * What an attempt sent back by a route was told, from its prompt: the route input's source and
 * the failed test's own TAP line; nothing for an attempt no route scheduled.
 */
export const routeLines = (ref: { stepId: string; attempt: number }, prompt: string): string[] => {
  const source = ROUTE_SOURCE.exec(prompt)?.[0];
  if (source === undefined) return [];
  const failed = prompt.split(/\r?\n/).filter((line) => /^\s*not ok \d+ - /.test(line));
  return [
    `demo: ${ref.stepId} #${ref.attempt} is told ${source}`,
    ...failed.map((line) => `  ${line.trim()}`),
  ];
};

/**
 * What a later round of a lens step was told, from its prompt: the change since the round before,
 * and the earlier rounds' findings with what was done with them (ADR 0190, ADR 0191); nothing for
 * a first round.
 */
export const laterRoundLines = (
  ref: { stepId: string; attempt: number },
  prompt: string,
): string[] => {
  const lines = prompt.split(/\r?\n/);
  /** The source and the lines of the prompt's input named `name`, or undefined without one. */
  const input = (name: string) => {
    const opening = new RegExp(`^<(untrusted-input-\\w+) source="([^"]*)" name="${name}">$`);
    const open = lines.findIndex((line) => opening.test(line));
    if (open === -1) return undefined;
    const [, tag = '', source = ''] = opening.exec(lines[open] ?? '') ?? [];
    const close = lines.indexOf(`</${tag}>`, open);
    return { source, text: lines.slice(open + 1, close === -1 ? undefined : close) };
  };
  const change = input('roundChange');
  if (change === undefined) return [];
  const findings = input('earlierFindings');
  const told = `demo: ${ref.stepId} #${ref.attempt} is told ${change.source}, as {roundChange}`;
  if (findings === undefined) return [told];
  return [
    `${told}, and the earlier findings, as {earlierFindings}:`,
    ...findings.text.map((line) => `  ${line}`),
  ];
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
