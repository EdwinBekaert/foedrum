// npm run demo -- ladder (ADR 0294): not implemented yet.

import type { Event } from '../../src/schemas/events.ts';
import type { ProcessOutcome } from '../process-runner.ts';
import { USER } from './core.ts';
import { LIB, WEB } from './ladder-brewers.ts';
import type { Step } from './walkthrough.ts';

/** The order: an issue of the Brewery, labelled for mash, so no Innkeeper chooses its recipe. */
export const LADDER_ORDER = {
  number: 1,
  author: USER,
  labels: ['recipe:mash'],
  title: 'Greet in French on the web',
  body: `${WEB} greets its visitors in French, with the greeting ${LIB} gives.`,
};
/** The order's batch, which the Brewmaster plans. */
export const PLANNED = `${LADDER_ORDER.number}-1`;

/** How a life of the ladder's Cellar ends. */
export type LadderLife = 'plan' | 'lib' | 'web' | 'close';

/** The steps of the ladder, in the order it shows them. */
export const LADDER_STEPS: readonly (Omit<Step, 'id'> & { id: string })[] = [];

export type LadderLifeEnd =
  | { kind: 'brewing' }
  | { kind: 'ended'; line: string }
  | { kind: 'failed'; line: string };

export const ladderBreweryFiles = (): Record<string, string> => {
  throw new Error('not implemented');
};

export const ladderLocalConfig = (_workRoot: string, _clones: Record<string, string>): string => {
  throw new Error('not implemented');
};

export const ladderGitConfig = (_scratch: string): string => {
  throw new Error('not implemented');
};

export const ladderLifeEnd = (
  _life: LadderLife,
  _events: readonly { event: Event }[],
): LadderLifeEnd => {
  throw new Error('not implemented');
};

export const siblingSection = (_body: string): string[] => {
  throw new Error('not implemented');
};

export const ladderProblems = (_run: {
  lives: ReadonlyMap<LadderLife, ProcessOutcome>;
  pulls: readonly { repo: string; body: string }[];
  orderState: string | undefined;
  failedCommands: readonly string[];
}): string[] => {
  throw new Error('not implemented');
};
