// Out-doc frontmatter: how a brewer reports its outcome (brewers-and-recipes §2, ADR 0005).

import { LensName } from './ids.ts';
import { type DocResult, readDoc } from './read.ts';
import { NonEmpty, Question } from './step-outcome.ts';
import { z } from './zod.ts';

export const BlockerKind = z.enum(['findings', 'environment', 'divergence']);
export type BlockerKind = z.infer<typeof BlockerKind>;

/** The most dispositions an out doc lists, and the longest file and `why` of one (ADR 0191). */
export const MOST_DISPOSITIONS = 100;
export const MAX_DISPOSITION_FILE = 1_000;
export const MAX_DISPOSITION_WHY = 2_000;

const place = {
  file: NonEmpty.max(MAX_DISPOSITION_FILE)
    .regex(/^[^\r\n]*$/, 'Must be one line')
    .exactOptional(),
  line: z.int().positive().exactOptional(),
};
const said = NonEmpty.max(MAX_DISPOSITION_WHY);

/**
 * What the brewer a findings route brought back did with one finding of its route input
 * (ADR 0191), at the finding's place as the Taster wrote it, or the change as a whole without a
 * file: fixed, or with a `why`, dismissed as not a defect or left as there before the change
 * (ADR 0094), a `why` that names the evidence a later round checks (ADR 0204).
 */
export const Disposition = z.discriminatedUnion('disposition', [
  z.strictObject({ ...place, disposition: z.literal('fixed'), why: said.exactOptional() }),
  z.strictObject({ ...place, disposition: z.literal('dismissed'), why: said }),
  z.strictObject({ ...place, disposition: z.literal('pre-existing'), why: said }),
]);
export type Disposition = z.infer<typeof Disposition>;

const shared = {
  summary: NonEmpty.regex(/^[^\r\n]*$/, 'Must be one line'),
  assumptions: z.array(NonEmpty).default([]),
  // Optional, so an out doc without them reads as before; an older Foedrum cannot read one with
  // them (ADR 0191).
  dispositions: z.array(Disposition).max(MOST_DISPOSITIONS).exactOptional(),
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
  // Optional, so a one-lens out doc reads as before; an older Foedrum cannot read a finding with
  // it (ADR 0220, as ADR 0191 records for dispositions).
  lens: LensName.optional(),
});
export type TastingFinding = z.infer<typeof TastingFinding>;

/** The most items a Taster's `riskLeft` lists, and the longest one (ADR 0214). */
export const MOST_RISKS_LEFT = 10;
export const MAX_RISK_LEFT = 300;

/** One line of at most `max` characters. */
export const lineOf = (max: number) => NonEmpty.max(max).regex(/^[^\r\n]*$/, 'Must be one line');

/**
 * A Taster's out doc: the contract's, with its findings, a verdict when it is done, and the risk
 * its review leaves (ADR 0214), optional, so an out doc without it reads as before.
 */
export const TastingOutDoc = outDocFrontmatter({
  verdict: Verdict.optional(),
  findings: z.array(TastingFinding).default([]),
  riskLeft: z.array(lineOf(MAX_RISK_LEFT)).max(MOST_RISKS_LEFT).exactOptional(),
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

/**
 * The out doc of a Taster's step that reviews through `lenses` (ADR 0220): on a step of several
 * together, each finding names the lens it was found through, one of the step's; on a one-lens step,
 * a finding that names one names the step's, so no Taster labels its findings with lenses it was not
 * given.
 */
export const tastingOutDocOf = (lenses: readonly string[]): typeof TastingOutDoc =>
  TastingOutDoc.superRefine((doc, ctx) => {
    const [one, ...more] = lenses;
    for (const [at, { lens }] of doc.findings.entries()) {
      if (lens === undefined ? more.length === 0 : lenses.includes(lens)) continue;
      ctx.addIssue({
        code: 'custom',
        message:
          more.length === 0
            ? `Must be the step's lens, ${one}, or left out`
            : `Must name the lens it was found through: ${lenses.slice(0, -1).join(', ')} or ${lenses.at(-1)}`,
        path: ['findings', at, 'lens'],
      });
    }
  });

/** The lens a finding was found through: its own, or else its step's (ADR 0220). */
export const lensOfFinding = (
  finding: TastingFinding,
  stepLens: string | undefined,
): string | undefined => finding.lens ?? stepLens;

/** A finding's lens before the rest of its line, when it names one (ADR 0220). */
export const lensFirst = ({ lens }: { lens?: string | undefined }): string =>
  lens === undefined ? '' : `${lens}, `;

/** What a Taster reported in the out doc of an attempt that succeeded. */
export interface TastingReport {
  verdict: z.infer<typeof Verdict>;
  findings: readonly TastingFinding[];
  /** The risk left after its review and what it could not verify (ADR 0214); none when empty. */
  riskLeft?: readonly string[];
}

/**
 * The verdict and findings of an attempt's `output` when a Taster wrote it (ADR 0161), with its
 * risk left when it wrote any (ADR 0214); undefined for any other brewer's out doc, and for a
 * check's success, which has none.
 */
export const tastingOf = (output: unknown): TastingReport | undefined => {
  const read = TastingOutDoc.safeParse(output);
  if (!read.success || read.data.status !== 'done' || read.data.verdict === undefined) {
    return undefined;
  }
  const { verdict, findings, riskLeft = [] } = read.data;
  return { verdict, findings, ...(riskLeft.length === 0 ? {} : { riskLeft }) };
};

/** Where a finding or a disposition is: its file and line, or the change as a whole (ADR 0191). */
export const placeOf = ({
  file,
  line,
}: {
  file?: string | undefined;
  line?: number | undefined;
}) =>
  file === undefined ? 'the change as a whole' : `${file}${line === undefined ? '' : `:${line}`}`;

/** Any out doc's dispositions, read leniently: none when it lists none, or none it can read. */
const Disposed = z.object({ dispositions: z.array(Disposition) });

/** The dispositions of any out doc's output that lists them (ADR 0191); none for one without. */
export const dispositionsOf = (output: unknown): Disposition[] => {
  const read = Disposed.safeParse(output);
  return read.success ? read.data.dispositions : [];
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

/** The longest How it works and See it, the most before/after rows, and their longest value. */
export const MAX_HOW_IT_WORKS = 10_000;
export const MAX_SEE_IT = 1_000;
export const MOST_BEFORE_AFTER = 20;
export const MAX_BEFORE_AFTER = 200;

/** One row of the pull request's before/after table (ADR 0167). */
const BeforeAfterRow = z.strictObject({
  case: lineOf(MAX_BEFORE_AFTER),
  before: lineOf(MAX_BEFORE_AFTER),
  after: lineOf(MAX_BEFORE_AFTER),
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
  howItWorks: NonEmpty.max(MAX_HOW_IT_WORKS).optional(),
  seeIt: lineOf(MAX_SEE_IT).optional(),
  beforeAfter: z.array(BeforeAfterRow).max(MOST_BEFORE_AFTER).default([]),
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

/** The most changes a Finer lists, and the longest line of why it changed nothing. */
export const MOST_FINING_CHANGES = 50;
export const MAX_UNCHANGED = 1_000;

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
  changes: z.array(FiningChange).max(MOST_FINING_CHANGES).default([]),
  unchanged: lineOf(MAX_UNCHANGED).optional(),
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

/** The name of the Gauger's out doc schema (`output.schema`, ADR 0170): the default Gauger's. */
export const GAUGE = 'gauge';

/** The most names a Gauger gives in each list, and the longest name: the red proof's (ADR 0170). */
export const MOST_TESTS = 200;
export const MAX_TEST_NAME = 1_000;
const TestNames = z.array(lineOf(MAX_TEST_NAME)).max(MOST_TESTS).default([]);

/**
 * The out doc of a brewer whose schema is `gauge`: the contract's, with its new tests and its
 * regression tests, by the names the runner reports (ADR 0170).
 */
export const GaugeOutDoc = outDocFrontmatter({ tests: TestNames, regressionTests: TestNames });

/** The tests a Gauger named (ADR 0170), by the names the runner reports: model text, untrusted. */
export interface GaugeReport {
  tests: readonly string[];
  regressionTests: readonly string[];
}

/** Any out doc's lists of tests, read leniently: a Brewery's own brewer may name them too. */
const NamedTests = z.object({
  tests: z.array(z.string()).max(MOST_TESTS).default([]),
  regressionTests: z.array(z.string()).max(MOST_TESTS).default([]),
});

/**
 * The tests of an attempt's `output` when it names any; undefined for an out doc without them,
 * and for a check's success, which has none.
 */
export const gaugeOf = (output: unknown): GaugeReport | undefined => {
  const read = NamedTests.safeParse(output);
  if (!read.success) return undefined;
  const { tests, regressionTests } = read.data;
  return tests.length === 0 && regressionTests.length === 0
    ? undefined
    : { tests, regressionTests };
};
