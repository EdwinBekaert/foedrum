// The commands of the command layer (ADR 0019): one schema each, the input its handler takes,
// whichever surface it came from. doctor, status, stuck and replay are read-only (ADR 0030); the
// others change state, and parse untrusted input into the engine's human commands (ADR 0025).

import { Repo } from './events.ts';
import { PathSafeId, RepositoryAlias } from './ids.ts';
import { Duration } from './primitives.ts';
import { NonEmpty } from './step-outcome.ts';
import { CommitSha } from './store.ts';
import { z } from './zod.ts';

export const DoctorCommand = z.strictObject({ command: z.literal('doctor') });
export type DoctorCommand = z.infer<typeof DoctorCommand>;

/**
 * `foedrum init`: a Brewery's files, and outside a clone its repository, from a few questions (ADR
 * 0199, ADR 0207). Each option is the answer to one question as it would be typed, the repeated ones
 * keyed `<repository or file>=<answer>`; init reads them as it reads a typed answer (ADR 0212).
 */
export const InitCommand = z.strictObject({
  command: z.literal('init'),
  brewery: z.string().optional(),
  visibility: z.string().optional(),
  targets: z.string().optional(),
  alias: z.array(z.string()).optional(),
  'use-checks': z.array(z.string()).optional(),
  check: z.array(z.string()).optional(),
  change: z.array(z.string()).optional(),
  label: z.array(z.string()).optional(),
  push: z.string().optional(),
  shim: z.string().optional(),
  repoint: z.string().optional(),
  /** `--no-input`: refuse a question no option answers instead of asking it. */
  'no-input': z.literal(true).optional(),
});
export type InitCommand = z.infer<typeof InitCommand>;

export const StatusCommand = z.strictObject({
  command: z.literal('status'),
  /** `--watch`: draw a board of the live batches until Ctrl+C (ADR 0188). */
  watch: z.literal(true).optional(),
});
export type StatusCommand = z.infer<typeof StatusCommand>;

export const StuckCommand = z.strictObject({ command: z.literal('stuck') });
export type StuckCommand = z.infer<typeof StuckCommand>;

/** `foedrum brewers` (ADR 0159): each brewer's attempts, outcomes, Stuck batches and tokens. */
export const BrewersCommand = z.strictObject({ command: z.literal('brewers') });
export type BrewersCommand = z.infer<typeof BrewersCommand>;

export const LensesCommand = z.strictObject({ command: z.literal('lenses') });
export type LensesCommand = z.infer<typeof LensesCommand>;

export const ReplayCommand = z.strictObject({ command: z.literal('replay'), batch: PathSafeId });
export type ReplayCommand = z.infer<typeof ReplayCommand>;

/** `foedrum resume <batch> [<step>[#<n>]]` (ADR 0126); resume reads the step and its attempt. */
export const ResumeCommand = z.strictObject({
  command: z.literal('resume'),
  batch: PathSafeId,
  step: NonEmpty.optional(),
});
export type ResumeCommand = z.infer<typeof ResumeCommand>;

export const RetryCommand = z.strictObject({ command: z.literal('retry'), batch: PathSafeId });
export type RetryCommand = z.infer<typeof RetryCommand>;

export const SkipCommand = z.strictObject({ command: z.literal('skip'), batch: PathSafeId });
export type SkipCommand = z.infer<typeof SkipCommand>;

export const CancelCommand = z.strictObject({ command: z.literal('cancel'), batch: PathSafeId });
export type CancelCommand = z.infer<typeof CancelCommand>;

/** One answer per question the batch asked, in the order it asked them. */
export const AnswerCommand = z.strictObject({
  command: z.literal('answer'),
  batch: PathSafeId,
  answers: z.array(NonEmpty).min(1),
});
export type AnswerCommand = z.infer<typeof AnswerCommand>;

// `owner/name=<commit>` split at its last `=`; `undefined` when either part is not one.
const splitRepoCommit = (text: string): [string, string] | undefined => {
  const at = text.lastIndexOf('=');
  const repo = Repo.safeParse(text.slice(0, at));
  const commit = CommitSha.safeParse(text.slice(at + 1));
  return at > 0 && repo.success && commit.success ? [repo.data, commit.data] : undefined;
};

/** `owner/name=<commit>`: the commit a rewind resets a repository to (ADR 0025). */
export const RepoCommit = z
  .string()
  .refine((text) => splitRepoCommit(text) !== undefined, 'Must be owner/name=<full commit sha>')
  .transform((text) => splitRepoCommit(text) as [string, string]);

export const RewindCommand = z.strictObject({
  command: z.literal('rewind'),
  batch: PathSafeId,
  step: PathSafeId,
  commits: z
    .array(RepoCommit)
    .min(1)
    .refine(
      (commits) => new Set(commits.map(([repo]) => repo.toLowerCase())).size === commits.length,
      'Must name each repository once',
    ),
});
export type RewindCommand = z.infer<typeof RewindCommand>;

/** An issue `foedrum order` names: of the target repository with `alias`, or of the Brewery. */
export interface OrderTarget {
  alias?: string;
  issue: number;
}

// `<alias>#<n>`, `#<n>` or `<n>`; `undefined` when it is none of them. `#` starts a comment in
// bash and PowerShell, so a Brewery issue may go without it.
const splitIssue = (text: string): OrderTarget | undefined => {
  const parts = /^(?:([^#]*)#)?([1-9][0-9]*)$/.exec(text);
  const [, alias, digits = ''] = parts ?? [];
  const issue = Number(digits);
  if (parts === null || !Number.isSafeInteger(issue)) return undefined;
  if (alias === undefined || alias === '') return { issue };
  return RepositoryAlias.safeParse(alias).success ? { alias, issue } : undefined;
};

/** `<alias>#<n>`: an issue of the repository with that alias; `#<n>` or `<n>`: a Brewery issue. */
const IssueTarget = z
  .string()
  .refine(
    (text) => splitIssue(text) !== undefined,
    'Must be <alias>#<n> of a target repository, or #<n> of the Brewery',
  )
  .transform((text) => splitIssue(text) as OrderTarget);

export const OrderCommand = z.strictObject({ command: z.literal('order'), issue: IssueTarget });
export type OrderCommand = z.infer<typeof OrderCommand>;

/**
 * A batch id, or an issue as `order` takes it (ADR 0240): a batch id has a hyphen and no `#`, so
 * `#<n>`, `<n>` and `<alias>#<n>` are never one.
 */
const asIssue = (text: string): boolean => /^[0-9]*$|#/.test(text);
const BatchOrIssue = z
  .string()
  .refine(
    (text) => (asIssue(text) ? splitIssue(text) !== undefined : PathSafeId.safeParse(text).success),
    'Must be a batch id, <alias>#<n> of a target repository, or #<n> of the Brewery',
  )
  .transform((text): string | OrderTarget =>
    asIssue(text) ? (splitIssue(text) as OrderTarget) : text,
  );

export const RecipeCommand = z.strictObject({
  command: z.literal('recipe'),
  target: BatchOrIssue,
  recipe: PathSafeId,
  reason: NonEmpty,
});
export type RecipeCommand = z.infer<typeof RecipeCommand>;

/** `first`, or a place of the intake's queue counted from 1 (ADR 0208). */
const RankPlaceArgument = z.union([
  z.literal('first'),
  z
    .string()
    .regex(/^[1-9][0-9]{0,5}$/, 'Must be first, or a place in the queue counted from 1')
    .transform(Number),
]);

/**
 * `foedrum rank <order> [<n> | first] [--why <reason>]` (ADR 0208): an order as `pause` takes it,
 * and where to put it in the intake's queue; with no place, it prints the order's.
 */
export const RankCommand = z
  .strictObject({
    command: z.literal('rank'),
    order: IssueTarget,
    place: RankPlaceArgument.optional(),
    why: NonEmpty.optional(),
  })
  .refine(({ place, why }) => why === undefined || place !== undefined, {
    message: 'Give --why with a place: <n> or first',
    path: ['why'],
  });
export type RankCommand = z.infer<typeof RankCommand>;

/**
 * `foedrum takeover <batch> [--as <name>]` (ADR 0124): the batch, and the driver it hands it to,
 * the Cellar's included.
 */
export const TakeoverCommand = z.strictObject({
  command: z.literal('takeover'),
  batch: PathSafeId,
  as: PathSafeId.optional(),
});
export type TakeoverCommand = z.infer<typeof TakeoverCommand>;

/** The Cellar's driver owner (ADR 0037), which no other driver may take (ADR 0123). */
export const CELLAR_OWNER = 'cellar';

/** A driver's name for `--as`: one path segment that is not the Cellar's (ADR 0123). */
const DriverName = PathSafeId.refine(
  (name) => name !== CELLAR_OWNER,
  "Must not be cellar, the Cellar's own",
);

/**
 * `foedrum brew <issue> [--as <name>]` (ADR 0123): the issue as `order` takes it, and the name of
 * its driver, one path segment that is not the Cellar's.
 */
export const BrewCommand = z.strictObject({
  command: z.literal('brew'),
  issue: IssueTarget,
  as: DriverName.optional(),
  /** `--take`: take the batch over from the driver that holds it (ADR 0124). */
  take: z.literal(true).optional(),
  /** `--new-window`: run `foedrum brew <issue> --take` in a new terminal window (ADR 0222). */
  'new-window': z.literal(true).optional(),
});
export type BrewCommand = z.infer<typeof BrewCommand>;

/**
 * `foedrum mash <issue> [--as <name>] [--take]` (ADR 0232): a Brewery issue, a claimed issue's
 * order included, routed to mash-in and brewed as `brew` does until its question.
 */
export const MashCommand = z.strictObject({
  command: z.literal('mash'),
  issue: IssueTarget.refine(
    ({ alias }) => alias === undefined,
    'Must be #<n> of the Brewery: a claimed issue is mashed by its Brewery issue',
  ),
  as: DriverName.optional(),
  take: z.literal(true).optional(),
});
export type MashCommand = z.infer<typeof MashCommand>;

/** A local time `HH:MM` on a 24-hour clock, such as `17:30` (ADR 0202). */
export const LocalTime = z.string().regex(/^([01][0-9]|2[0-3]):([0-5][0-9])$/);

/** What `pause --by` takes, as its refusal says it (ADR 0202). */
export const STOP_TIME_HELP =
  'Must be a local time HH:MM, such as 17:30, or a duration, such as 20m';

/** `--by`: a local time today (tomorrow once past), or a duration from now (ADR 0202). */
export const StopTime = z
  .string()
  .refine(
    (text) => LocalTime.safeParse(text).success || Duration.safeParse(text).success,
    STOP_TIME_HELP,
  );

const oneOrAll = ({ order, all }: { order?: OrderTarget | undefined; all?: true | undefined }) =>
  (order === undefined) !== (all === undefined);
const ONE_OR_ALL = 'Name one order (<alias>#<n> or #<n>), or --all, and not both';

/**
 * `foedrum pause [<order> | --all] [--by <time>] [--why <reason>]` (ADR 0202): an order as
 * `order` takes an issue, or the whole Brewery and its intake.
 */
export const PauseCommand = z
  .strictObject({
    command: z.literal('pause'),
    order: IssueTarget.optional(),
    all: z.literal(true).optional(),
    by: StopTime.optional(),
    why: NonEmpty.optional(),
  })
  .refine(oneOrAll, { message: ONE_OR_ALL, path: ['order'] });
export type PauseCommand = z.infer<typeof PauseCommand>;

/** `foedrum continue [<order> | --all]` (ADR 0202): lifts an order's pause, or every one. */
export const ContinueCommand = z
  .strictObject({
    command: z.literal('continue'),
    order: IssueTarget.optional(),
    all: z.literal(true).optional(),
  })
  .refine(oneOrAll, { message: ONE_OR_ALL, path: ['order'] });
export type ContinueCommand = z.infer<typeof ContinueCommand>;

/**
 * `foedrum stop <order> [--why <reason>]` (ADR 0205): the order's brewing batches go Stuck at once.
 * No `--all`: `pause --all --by` stops everything that runs.
 */
export const StopCommand = z.strictObject({
  command: z.literal('stop'),
  order: IssueTarget,
  why: NonEmpty.optional(),
});
export type StopCommand = z.infer<typeof StopCommand>;
