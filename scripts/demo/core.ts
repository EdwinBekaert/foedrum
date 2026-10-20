// npm run demo's decisions (ADR 0097): where its scratch folder may be, the Brewery it makes
// there, the order on the fake code host, and whether a run ended as it should. The shell is
// scripts/demo.ts; one life of the Cellar is scripts/demo/cellar.ts.

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

/**
 * The demo's scratch folder: `.foedrum/tmp/demo` in the checkout, or `asked` resolved against
 * the working directory, which must be inside the checkout's `.foedrum/tmp`.
 */
export const scratchFolder = (_root: string, _asked: string | undefined, _cwd: string): string => {
  throw new Error('not implemented');
};

/** The Brewery's files, by path relative to its checkout. */
export const breweryFiles = (): Record<string, string> => {
  throw new Error('not implemented');
};

/** `.foedrum/local.jsonc`: the work root and the user's clone of the target repository. */
export const localConfig = (_workRoot: string, _clone: string): string => {
  throw new Error('not implemented');
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

/** What went wrong in a run, one line each; none when it ended as it should. */
export const problemsOf = (_run: DemoRun): string[] => {
  throw new Error('not implemented');
};
