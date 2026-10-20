// npm run demo's decisions (ADR 0097): where its scratch folder may be, the Brewery it makes
// there, the order on the fake code host, and whether a run ended as it should. The shell is
// scripts/demo.ts; one life of the Cellar is scripts/demo/cellar.ts.

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ServeInputs } from '../../src/cli/serve-config.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { Event, StuckReason } from '../../src/schemas/events.ts';
import type { ProcessOutcome } from '../process-runner.ts';

/** The Brewery the demo makes, and its one target repository. */
export const BREWERY = 'demo/brewery';
export const TARGET = 'demo/web';
/** The user who may order work, and the code host's login for the Cellar. */
export const USER = 'ann';
export const LOGIN = 'cellar-bot';

/** The issue the demo orders: in the Brewery's repository, labelled for its recipe. */
export const ORDER = {
  number: 1,
  title: 'Greet the visitors',
  body: 'Add a greeting.txt that says hello.',
  labels: ['recipe:stout'],
  author: USER,
};

/**
 * What serve would learn from doctor: no claude is started, so none is looked for, and no brewer
 * runs in Claude Code's sandbox.
 */
export const DIAGNOSIS: ServeInputs['diagnosis'] = {
  tools: [{ name: 'claude', version: undefined, path: 'the demo brewer, never started' }],
  isolation: { level: 'permissions only', why: 'the demo brewer is scripted' },
  problems: [],
};

/** Who the demo commits as, in its own git configuration. */
export const IDENTITY = { name: 'Demo brewer', email: 'brewer@demo.invalid' };

/**
 * The git configuration every git of the demo reads as its global one, with no system one: the
 * demo's identity, no commit signing, and the target repository's URL on GitHub rewritten to the
 * scratch `remote`, so serve's own fetches and pushes reach it. Every other GitHub URL goes to a
 * path next to it that does not exist (git takes the longest matching insteadOf), so a URL serve
 * names some other way fails on the machine instead of reaching github.com.
 */
export const gitConfig = (remote: string): string => {
  // A subsection name is quoted: its backslashes and double quotes are escaped.
  const subsection = (path: string): string =>
    `[url "${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;
  return [
    '[user]',
    `\tname = ${IDENTITY.name}`,
    `\temail = ${IDENTITY.email}`,
    '[commit]',
    '\tgpgsign = false',
    subsection(remote),
    `\tinsteadOf = https://github.com/${TARGET}.git`,
    subsection(join(dirname(remote), 'no-such-remote')),
    '\tinsteadOf = https://github.com/',
    '',
  ].join('\n');
};

/** How a life of the Cellar ends: killed mid-attempt, or once the batch is on tap. */
export type Life = 'crash' | 'finish';

/** The line the Cellar prints right before its process is killed. */
export const CRASH_LINE = 'demo: the brewer committed; the Cellar is killed mid-attempt';
/** The start of the line the Cellar prints once the batch is on tap. */
export const ON_TAP_LINE = 'demo: batch 1-1 is on tap';

const tmpOf = (root: string): string => join(root, '.foedrum', 'tmp');

/**
 * The demo's scratch folder: `.foedrum/tmp/demo` in the checkout, or `asked` resolved against
 * `cwd`, which must be inside the checkout's `.foedrum/tmp` (and not that folder itself): the
 * folder is removed at the start of every run.
 */
export const scratchFolder = (root: string, asked: string | undefined, cwd: string): string => {
  const tmp = tmpOf(root);
  if (asked === undefined) return join(tmp, 'demo');
  const path = resolve(cwd, asked);
  const inside = relative(tmp, path);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`npm run demo works only in a folder inside ${tmp}, not in ${path}`);
  }
  return path;
};

// Its brewer commits with no red proof before it, so the recipe says testFirst: false (ADR 0064),
// and the commits go into a pull request (ADR 0084).
const RECIPE = {
  name: 'stout',
  description: 'Brews an order in one step and opens its pull request.',
  steps: [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
  testFirst: false,
};

// As the docs' example brewer, with a second attempt for the one the crash takes (ADR 0074).
const BREWER = `---
{
  "name": "cellarman",
  "description": "Brews the order.",
  "version": 1,
  "inputs": [{ "name": "order", "from": "order" }],
  "output": { "doc": "brew.md", "schema": "outDoc" },
  "produces": "commits",
  "model": "quick",
  "effort": "low",
  "tools": { "allow": ["Read", "Write"] },
  "access": "write",
  "tree": "task",
  "git": { "commit": true },
  "deadline": "10m",
  "maxAttempts": 2
}
---
Brew the order in {order}.
`;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The Brewery's files, by path relative to its checkout. */
export const breweryFiles = (): Record<string, string> => ({
  'foedrum.jsonc': json({
    brewery: BREWERY,
    users: [USER],
    repositories: {
      [TARGET]: { checks: { build: null, typecheck: null, lint: null, format: null, test: null } },
    },
  }),
  // The model a brewer would get; the scripted one asks none.
  'models.jsonc': json({ models: { quick: 'claude-haiku-5-5' } }),
  '.gitignore': '.foedrum/\n',
  'recipes/stout.jsonc': json(RECIPE),
  'brewers/cellarman.md': BREWER,
});

/** `.foedrum/local.jsonc`: the work root and the user's clone of the target repository. */
export const localConfig = (workRoot: string, clone: string): string =>
  json({ workRoot, clones: { [TARGET]: clone } });

/** How a life of the Cellar ends, read from its store. */
export type LifeEnd =
  | { kind: 'on_tap'; pullRequests: readonly string[] }
  | { kind: 'stuck'; reason: string }
  | { kind: 'cancelled' };

/** Why a batch is Stuck, in one line. */
const stuckReason = (reason: StuckReason): string => {
  const why =
    'lastReason' in reason ? reason.lastReason : 'summary' in reason ? reason.summary : '';
  const step = 'stepId' in reason ? ` at step ${reason.stepId}` : '';
  return `${reason.kind}${step}${why === '' ? '' : `: ${why}`}`;
};

/**
 * How the life ends, from the store's events in order, or undefined while the batch still
 * brews: on tap once the status comment's revision that shows it is applied after it (ADR
 * 0072), and at once when the batch is Stuck or cancelled, which the demo cannot recover from.
 */
export const lifeEndOf = (events: readonly { event: Event }[]): LifeEnd | undefined => {
  let end: LifeEnd | undefined;
  let tapped: readonly string[] | undefined;
  for (const { event } of events) {
    switch (event.type) {
      case 'batch.on_tap':
        tapped = event.pullRequests;
        break;
      case 'effect.applied':
        if (tapped !== undefined && effectKey.decode(event.key).effect.startsWith('status.')) {
          end = { kind: 'on_tap', pullRequests: tapped };
        }
        break;
      case 'batch.stuck':
        end = { kind: 'stuck', reason: stuckReason(event.reason) };
        break;
      case 'batch.resumed':
      case 'batch.rewound':
        end = undefined;
        break;
      case 'batch.cancelled':
        end = { kind: 'cancelled' };
        break;
      // The batch brews on: none of these ends a life.
      case 'order.decomposed':
      case 'batch.ordered':
      case 'batch.recipe_chosen':
      case 'step.scheduled':
      case 'step.skipped':
      case 'step.started':
      case 'step.finished':
      case 'input.received':
      case 'batch.waiting':
      case 'bottle.opened':
      case 'release.observed':
      case 'pull_request.ended':
        break;
      default:
        event satisfies never;
    }
  }
  return end;
};

/** What a run left, as the demo's shell gathered it. */
export interface DemoRun {
  /** The first life of the Cellar, killed mid-attempt. */
  crash: ProcessOutcome;
  /** The second, started again on the same Brewery. */
  restart: ProcessOutcome;
  /** The pull requests on the fake code host. */
  pulls: readonly { title: string; head: string; base: string }[];
  /** The comments on the order's issue there. */
  comments: readonly { author: string; body: string }[];
}

/** The last lines of a process's output, to say why. */
const tail = (output: string): string => {
  const lines = output.trimEnd().split(/\r?\n/).slice(-10);
  return lines.length === 1 && lines[0] === '' ? '(no output)' : lines.join('\n');
};

/** How a process ended, in a few words. */
const ending = ({ exitCode, killed }: ProcessOutcome): string =>
  killed === undefined ? `exit code ${exitCode}` : `killed: ${killed}`;

/** What went wrong in a run, one line each; none when it ended as it should. */
export const problemsOf = (run: DemoRun): string[] => {
  const { crash, restart, pulls, comments } = run;
  const problems: string[] = [];
  // Killed by the process itself, never by the runner: a deadline means it never crashed.
  if (crash.exitCode === 0 || crash.killed !== undefined || !crash.output.includes(CRASH_LINE)) {
    problems.push(
      `the first Cellar was not killed mid-attempt (${ending(crash)}):\n${tail(crash.output)}`,
    );
  }
  if (restart.exitCode !== 0 || !restart.output.includes(ON_TAP_LINE)) {
    problems.push(
      `the batch is not on tap after the restart (${ending(restart)}):\n${tail(restart.output)}`,
    );
  }
  if (pulls.length !== 1) problems.push(`the code host has ${pulls.length} pull requests, not 1`);
  if (comments.length !== 1) {
    problems.push(`the order has ${comments.length} status comments, not 1`);
  }
  return problems;
};
