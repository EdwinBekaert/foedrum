// Out-doc frontmatter: how a brewer reports its outcome (brewers-and-recipes §2, ADR 0005).

import { type DocResult, readDoc } from './read.ts';
import { NonEmpty, Question } from './step-outcome.ts';
import { z } from './zod.ts';

export const BlockerKind = z.enum(['findings', 'environment', 'divergence']);
export type BlockerKind = z.infer<typeof BlockerKind>;

const shared = {
  summary: NonEmpty.regex(/^[^\r\n]*$/, 'Must be one line'),
  assumptions: z.array(NonEmpty).default([]),
};

// `questions` only with needs_input and `blockerKind` only with blocked: strict objects reject them elsewhere.
const variants = [
  z.strictObject({ status: z.literal('done'), ...shared }),
  z.strictObject({
    status: z.literal('needs_input'),
    ...shared,
    questions: z.array(Question).min(1),
  }),
  z.strictObject({ status: z.literal('blocked'), ...shared, blockerKind: BlockerKind }),
  z.strictObject({ status: z.literal('failed'), ...shared }),
] as const;

const contractFields = new Set(variants.flatMap((variant) => Object.keys(variant.shape)));

/** The out-doc frontmatter with a brewer's own fields (for example a review verdict) added to every status. */
export const outDocFrontmatter = <Fields extends z.ZodRawShape>(fields: Fields) => {
  const replaced = Object.keys(fields).filter((key) => contractFields.has(key));
  if (replaced.length > 0) {
    throw new Error(`Brewer-specific fields cannot replace the out-doc contract: ${replaced}`);
  }
  return z.discriminatedUnion('status', [
    variants[0].extend(fields),
    variants[1].extend(fields),
    variants[2].extend(fields),
    variants[3].extend(fields),
  ]);
};

export const OutDocFrontmatter = z.discriminatedUnion('status', [...variants]);
export type OutDocFrontmatter = z.infer<typeof OutDocFrontmatter>;

/** Reads an out doc; a syntax error or a frontmatter that breaks `schema` makes it invalid, with the reason. */
export function readOutDoc<T>(text: string, schema: z.ZodType<T>): DocResult<T> {
  return readDoc(text, schema);
}

/** The name of a Taster's out doc schema (`output.schema`): what makes a brewer a Taster (ADR 0161). */
export const TASTING = 'tasting';

/** A Taster's verdict: `changes` holds a blocking step up (ADR 0161). */
export const Verdict = z.enum(['approve', 'changes']);

/**
 * One finding of a Taster (ADR 0161): where, how bad, and why; `introduced` is false for a defect
 * that was there before the change (ADR 0094). A finding about the change as a whole has no file.
 */
export const TastingFinding = z.strictObject({
  file: NonEmpty.regex(/^[^\r\n]*$/, 'Must be one line').optional(),
  line: z.int().positive().optional(),
  severity: z.enum(['blocker', 'major', 'minor']),
  why: NonEmpty,
  introduced: z.boolean(),
});
export type TastingFinding = z.infer<typeof TastingFinding>;

/** A Taster's out doc: the contract's, with its findings, and a verdict when it is done. */
export const TastingOutDoc = outDocFrontmatter({
  verdict: Verdict.optional(),
  findings: z.array(TastingFinding).default([]),
}).superRefine((doc, ctx) => {
  if (doc.status !== 'done') return;
  if (doc.verdict === undefined) {
    ctx.addIssue({ code: 'custom', message: 'A done Taster gives a verdict', path: ['verdict'] });
    return;
  }
  // The verdict follows from the findings, so the engine, not the model, decides what holds a
  // blocking step up (ADR 0161).
  const holds = doc.findings.some(
    ({ severity, introduced }) => introduced && (severity === 'blocker' || severity === 'major'),
  );
  if ((doc.verdict === 'changes') !== holds) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Must be "changes" exactly when a finding the change introduced is a blocker or major',
      path: ['verdict'],
    });
  }
});

/** What a Taster reported in the out doc of an attempt that succeeded. */
export interface TastingReport {
  verdict: z.infer<typeof Verdict>;
  findings: readonly TastingFinding[];
}

/**
 * The verdict and findings of an attempt's `output` when a Taster wrote it (ADR 0161); undefined
 * for any other brewer's out doc, and for a check's success, which has none.
 */
export const tastingOf = (output: unknown): TastingReport | undefined => {
  const read = TastingOutDoc.safeParse(output);
  if (!read.success || read.data.status !== 'done' || read.data.verdict === undefined) {
    return undefined;
  }
  return { verdict: read.data.verdict, findings: read.data.findings };
};

/**
 * The assumptions of an out doc that succeeded, beside whatever else it holds (a brewer's own
 * fields): what the status comment shows (ADR 0072).
 */
export const OutDocAssumptions = z.object({ assumptions: z.array(z.string()) });

/**
 * The name of the out doc schema of a brewer that writes the pull request's sections
 * (`output.schema`, ADR 0167): the default Cellarman's.
 */
export const PULL_REQUEST = 'pullRequest';

/** One line of at most `max` characters. */
const lineOf = (max: number) => NonEmpty.max(max).regex(/^[^\r\n]*$/, 'Must be one line');

/** One row of the pull request's before/after table (ADR 0167). */
const BeforeAfterRow = z.strictObject({
  case: lineOf(200),
  before: lineOf(200),
  after: lineOf(200),
});
type BeforeAfterRow = z.infer<typeof BeforeAfterRow>;

/** The pull request's sections a brewer wrote (ADR 0167): model text, untrusted. */
export interface PullRequestSections {
  howItWorks?: string;
  seeIt?: string;
  beforeAfter: readonly BeforeAfterRow[];
}

/**
 * The out doc of a brewer whose schema is `pullRequest`: the contract's, with the sections. They
 * are optional, since a retry for a missing one would redo the whole run; the limits keep the body
 * within GitHub's without cutting its Markdown.
 */
export const PullRequestOutDoc = outDocFrontmatter({
  howItWorks: NonEmpty.max(10_000).optional(),
  seeIt: lineOf(1_000).optional(),
  beforeAfter: z.array(BeforeAfterRow).max(20).default([]),
});

/**
 * The sections of an attempt's `output` when a `pullRequest` brewer wrote any and was done;
 * undefined for any other out doc.
 */
export const pullRequestSectionsOf = (output: unknown): PullRequestSections | undefined => {
  const read = PullRequestOutDoc.safeParse(output);
  if (!read.success || read.data.status !== 'done') return undefined;
  const { howItWorks, seeIt, beforeAfter } = read.data;
  if (howItWorks === undefined && seeIt === undefined && beforeAfter.length === 0) return undefined;
  return {
    ...(howItWorks === undefined ? {} : { howItWorks }),
    ...(seeIt === undefined ? {} : { seeIt }),
    beforeAfter,
  };
};

/**
 * The name of the out doc schema of a brewer that simplifies a batch's change (`output.schema`,
 * ADR 0166): the default Finer's.
 */
export const FINING = 'fining';

/** One change a Finer made (ADR 0166): where, and why; `line` when it is about one. */
const FiningChange = z.strictObject({
  file: lineOf(1_000),
  line: z.int().positive().optional(),
  why: NonEmpty,
});
export type FiningChange = z.infer<typeof FiningChange>;

/** What a Finer reported: its changes, or why there was nothing to simplify (ADR 0166). */
export interface FiningReport {
  changes: readonly FiningChange[];
  unchanged?: string;
}

/**
 * The out doc of a brewer whose schema is `fining`: the contract's, with its changes. A `done`
 * lists them, or says why there was nothing to simplify, never both: the engine reads which, to
 * take a done without a commit (ADR 0166).
 */
export const FiningOutDoc = outDocFrontmatter({
  changes: z.array(FiningChange).max(50).default([]),
  unchanged: lineOf(1_000).optional(),
}).superRefine((doc, ctx) => {
  if (doc.status !== 'done' || doc.changes.length > 0 !== (doc.unchanged !== undefined)) return;
  ctx.addIssue({
    code: 'custom',
    message: 'A done Finer gives exactly one of a non-empty changes or unchanged',
    path: ['unchanged'],
  });
});

/** The changes of an attempt's `output` when a Finer wrote it and was done; else undefined. */
export const finingOf = (output: unknown): FiningReport | undefined => {
  const read = FiningOutDoc.safeParse(output);
  if (!read.success || read.data.status !== 'done') return undefined;
  const { changes, unchanged } = read.data;
  return unchanged === undefined ? { changes } : { changes, unchanged };
};
