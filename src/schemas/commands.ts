// The commands of the command layer (ADR 0019): one schema each, the input its handler takes,
// whichever surface it came from. doctor, status, stuck and replay are read-only (ADR 0030); the
// others change state, and parse untrusted input into the engine's human commands (ADR 0025).

import { Repo } from './events.ts';
import { PathSafeId, RepositoryAlias } from './ids.ts';
import { NonEmpty } from './step-outcome.ts';
import { CommitSha } from './store.ts';
import { z } from './zod.ts';

export const DoctorCommand = z.strictObject({ command: z.literal('doctor') });
export type DoctorCommand = z.infer<typeof DoctorCommand>;

/** `foedrum init`: a Brewery's files in its clone, from a few questions (ADR 0199). */
export const InitCommand = z.strictObject({ command: z.literal('init') });
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

export const RecipeCommand = z.strictObject({
  command: z.literal('recipe'),
  batch: PathSafeId,
  recipe: PathSafeId,
  reason: NonEmpty,
});
export type RecipeCommand = z.infer<typeof RecipeCommand>;

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

/**
 * `foedrum brew <issue> [--as <name>]` (ADR 0123): the issue as `order` takes it, and the name of
 * its driver, one path segment that is not the Cellar's.
 */
export const BrewCommand = z.strictObject({
  command: z.literal('brew'),
  issue: IssueTarget,
  as: PathSafeId.refine(
    (name) => name !== CELLAR_OWNER,
    "Must not be cellar, the Cellar's own",
  ).optional(),
  /** `--take`: take the batch over from the driver that holds it (ADR 0124). */
  take: z.literal(true).optional(),
});
export type BrewCommand = z.infer<typeof BrewCommand>;
