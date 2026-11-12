// The rack issue every 4 weeks (ADR 0387): serve reads the Brewery's issues labelled recipe:rack,
// open or closed, at its start and then at most once an hour, and opens one when there is none, or
// the newest was opened 28 days ago or more and none is open. Serve keeps no date: the issue it
// opened is its own record, found open by the next read, so a crash after the open opens no second.

import type { Recipe } from './recipes.ts';

/** The label of the issue serve opens, which the intake routes to the rack recipe (ADR 0383). */
export const RACK_LABEL = 'recipe:rack';

/** How long after the newest rack issue serve opens the next one: 4 weeks, fixed (ADR 0387). */
const RACK_EVERY_MS = 28 * 86_400_000;

/** How long between serve's reads of the rack issues (ADR 0387). */
const RACK_READ_EVERY_MS = 3_600_000;

/** A Brewery issue labelled recipe:rack, as the code host lists it. */
export interface RackIssue {
  state: 'open' | 'closed';
  /** When it was opened, ISO 8601. */
  created: string;
}

/** The Brewery's rack issues on the code host. Every call stops when `signal` aborts. */
export interface RackIssues {
  /** Every issue labelled recipe:rack, open or closed, without pull requests. */
  list(signal?: AbortSignal): Promise<readonly RackIssue[]>;
  /** Opens an issue labelled recipe:rack; its number. */
  open(title: string, body: string, signal?: AbortSignal): Promise<number>;
}

/** Whether serve opens a rack issue now, given every one there is. */
const rackDue = (issues: readonly RackIssue[], now: Date): boolean =>
  issues.every(
    (issue) =>
      issue.state === 'closed' && now.getTime() - Date.parse(issue.created) >= RACK_EVERY_MS,
  );

const UNITS = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1_000, 'second'],
] as const;

/** A step's `olderThan` in words, in the largest unit it is a whole number of: `90 days`. */
const inWords = (ms: number): string => {
  const [size, unit] = UNITS.find(([each]) => ms % each === 0) ?? UNITS[3];
  const count = ms / size;
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
};

/** The rack issue's title and body, naming what the Brewery's own rack steps do (ADR 0387). */
const rackIssueText = (rack: Recipe): { title: string; body: string } => {
  const does = rack.steps.flatMap((stepId) => {
    const olderThan = rack.olderThan(stepId);
    const age = olderThan === undefined ? '' : ` older than ${inWords(olderThan)}`;
    switch (rack.action(stepId)) {
      case 'archive':
        return ['- it archives the finished batches on the state branch,'];
      case 'deleteArchives':
        return [`- it deletes archive folders${age},`];
      case 'deleteTemporary':
        return [`- it deletes temporary files in .foedrum/tmp/${age},`];
      default:
        return [];
    }
  });
  const body = [
    'Foedrum opens this issue every 4 weeks. Once you give your go, the rack recipe cleans up the Brewery:',
    '',
    ...does,
    '',
    "Nothing runs until you run `foedrum approve <n>` with this issue's number. To skip this cleanup, close the issue: the next one opens 4 weeks after this one was opened.",
  ].join('\n');
  return { title: 'Rack: clean up the Brewery', body };
};

export interface RackScheduleOptions {
  issues: RackIssues;
  /** The Brewery's rack recipe, whose steps the issue names. */
  rack: Recipe;
  clock: () => Date;
  /** Stops a read or an open underway. */
  signal: AbortSignal;
  /** The issue it opened. */
  opened: (issue: number) => void;
  /** A read or an open that failed: nothing opens, and the next read tries again. */
  failed: (error: unknown) => void;
}

export interface RackSchedule {
  /** Starts a read, and an open when one is due, unless one runs or the last began within the hour. */
  poll(): void;
  /** Settles once the read underway, if any, has. */
  settled(): Promise<void>;
}

export const createRackSchedule = (options: RackScheduleOptions): RackSchedule => {
  const { issues, rack, clock, signal } = options;
  let underway: Promise<void> | undefined;
  let next = Number.NEGATIVE_INFINITY;
  const check = async (): Promise<void> => {
    if (!rackDue(await issues.list(signal), clock())) return;
    const { title, body } = rackIssueText(rack);
    options.opened(await issues.open(title, body, signal));
  };
  return {
    poll: () => {
      const at = clock().getTime();
      if (underway !== undefined || at < next) return;
      next = at + RACK_READ_EVERY_MS;
      underway = check()
        // A read or an open the stop ended is no failure.
        .catch((error: unknown) => {
          if (!signal.aborted) options.failed(error);
        })
        .finally(() => {
          underway = undefined;
        });
    },
    settled: async () => {
      await underway;
    },
  };
};
