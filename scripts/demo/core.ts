// npm run demo's decisions (ADR 0097): where its scratch folder may be, the Brewery it makes
// there, the order on the fake code host, and whether a run ended as it should. The shell is
// scripts/demo.ts; one life of the Cellar is scripts/demo/cellar.ts.

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ServeInputs } from '../../src/cli/serve-config.ts';
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
  if (crash.exitCode === 0 || !crash.output.includes(CRASH_LINE)) {
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
