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
    | 'replay'
    | 'mash';
  title: string;
  lookFor: string;
}

/** The steps, in the order the walkthrough shows them. */
export const STEPS: readonly Step[] = [
  {
    id: 'diagnosis',
    title: 'The diagnosis serve runs with',
    lookFor:
      "the demo's own diagnosis, not foedrum doctor on this machine: it starts no claude and no gh.",
  },
  {
    id: 'order',
    title: 'The order comes in',
    lookFor:
      "an issue labelled recipe:nip-parallel is all serve needs: Nip's steps, tasted by three lenses at once.",
  },
  {
    id: 'brewing',
    title: 'foedrum status as the batch moves',
    lookFor:
      'the batch goes from the order to brewing; gauge #1 commits a failing test before the kill.',
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
      'red #1 sees the test fail; green #1 fails, so implement #2 is told why; correctness #1 blocks, so implement #3 runs and round 2 approves.',
  },
  {
    id: 'pull-request',
    title: 'The pull request and the status comment',
    lookFor:
      'one pull request and one status comment, though the Cellar lived twice; its path has a line per round.',
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
      "each lens's rounds, findings and tokens: correctness's finding is fixed; diff/acceptance, not in this recipe, has no rounds.",
  },
  {
    id: 'brew',
    title: `foedrum brew ${BREW_ORDER.number} --as ${USER}`,
    lookFor: `the same order again as issue #${BREW_ORDER.number}, brewed from a terminal: foedrum brew orders, routes and drives it to its pull request.`,
  },
  {
    id: 'resume',
    title: `foedrum resume ${BATCH} ${RESUMED}`,
    lookFor:
      "the line that opens the Cellarman's session in its worktree; the demo opens it nowhere, since it starts no claude.",
  },
  {
    id: 'replay',
    title: `foedrum replay ${BATCH}`,
    lookFor:
      "the state the fold makes of the batch's events; foedrum replay lists every event above it.",
  },
];

/** The heading line of `STEPS[index]`. */
export const headingOf = (index: number): string =>
  `Step ${index + 1} of ${STEPS.length}: ${STEPS[index]?.title}`;

/** The width the walkthrough wraps what to look for at. */
const WIDTH = 80;

/**
 * What the walkthrough prints to open `STEPS[index]`: a blank line, its heading, and what to look
 * for, wrapped at `WIDTH` under its label.
 */
export const stepLines = (index: number): string[] => {
  const lines: string[] = [];
  let line = 'Look for:';
  for (const word of (STEPS[index]?.lookFor ?? '').split(' ')) {
    if (line.length + 1 + word.length <= WIDTH) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = `${' '.repeat('Look for: '.length)}${word}`;
    }
  }
  return ['', headingOf(index), ...lines, line];
};

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
 * `foedrum replay <batch>`'s output with its Events block counted in one line instead of listed:
 * the State under it is what the walkthrough shows (#662).
 */
export const replayLines = (output: string, batch: string): string[] => {
  const lines = output.trimEnd().split(/\r?\n/);
  const start = lines.indexOf('Events');
  if (start === -1) return lines;
  const end = lines.indexOf('', start);
  const events = (end === -1 ? lines.length : end) - start - 1;
  return [
    ...lines.slice(0, start),
    `Events  ${events}, left out here: foedrum replay ${batch} lists them`,
    ...(end === -1 ? [] : lines.slice(end)),
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
