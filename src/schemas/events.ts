// Events: the append-only log that state is folded from (architecture §4.1, ADR 0002, ADR 0019).

import { PathSafeId } from './ids.ts';
import { BlockerKind } from './out-doc.ts';
import { NonEmpty, Question, StepOutcome } from './step-outcome.ts';
import { CommitSha, EffectKeyText } from './store.ts';
import { z } from './zod.ts';

const Id = NonEmpty;
// Batch and step ids are path segments on the state branch (ADR 0024).
const BatchId = PathSafeId;
const StepId = PathSafeId;
const Attempt = z.int().positive();
const Count = z.int().nonnegative();
const Timestamp = z.iso.datetime();
const IssueNumber = z.int().positive();
/** `owner/name` of a GitHub repository; neither part may be `.`, `..` or start with `-`. */
export const Repo = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[\w.][\w.-]*$/, 'Must be owner/name');
const PullRequestUrl = z
  .url({ protocol: /^https$/ })
  // Checked on the parsed URL: the parser also finds credentials in `HTTPS://`, `https:\\` or `https:/`.
  .refine((url) => {
    const parsed = URL.parse(url); // null when z.url already rejected it; zod runs this anyway
    return parsed?.username === '' && parsed.password === '';
  }, 'Must not contain credentials');

/** Where a command or answer came from (ADR 0019). */
export const Surface = z.enum(['plugin', 'terminal', 'comment', 'dashboard']);
export type Surface = z.infer<typeof Surface>;

/** The Claude Code session of an attempt, so any action can resume the right session (ADR 0019). */
export const SessionRef = z.strictObject({
  id: Id,
  resumes: Id.optional(),
  worktree: NonEmpty,
  claudeVersion: NonEmpty,
});
export type SessionRef = z.infer<typeof SessionRef>;

/** An order or sub-order: an issue in the Brewery. */
export const OrderRef = z.strictObject({ issue: IssueNumber });
export type OrderRef = z.infer<typeof OrderRef>;

/** A sub-order writes in exactly one repository (architecture §3.2). */
export const SubOrderRef = z.strictObject({ issue: IssueNumber, repo: Repo });
export type SubOrderRef = z.infer<typeof SubOrderRef>;

/** `subOrder` waits for `blockedBy`'s branch (`code`) or for its release (`release`). */
export const Dependency = z.strictObject({
  subOrder: IssueNumber,
  blockedBy: IssueNumber,
  kind: z.enum(['code', 'release']),
});
export type Dependency = z.infer<typeof Dependency>;

export const Usage = z.strictObject({
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
});
export type Usage = z.infer<typeof Usage>;

export const Answer = z.strictObject({ q: NonEmpty, answer: NonEmpty });
export type Answer = z.infer<typeof Answer>;

export const StuckReason = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('needs_input'),
    stepId: StepId,
    questions: z.array(Question).min(1),
  }),
  z.strictObject({
    kind: z.literal('blocked'),
    stepId: StepId,
    blockerKind: BlockerKind,
    summary: NonEmpty,
  }),
  z.strictObject({
    kind: z.literal('attempts_exhausted'),
    stepId: StepId,
    attempts: Attempt,
    lastReason: NonEmpty,
  }),
  z.strictObject({ kind: z.literal('deadline_passed'), stepId: StepId, deadlineAt: Timestamp }),
  z.strictObject({ kind: z.literal('waiting_for_session'), stepId: StepId }),
  // No file write or commit since `lastProgressAt`, for `turnsWithoutProgress` turns (ADR 0026).
  z.strictObject({
    kind: z.literal('stalled'),
    stepId: StepId,
    lastProgressAt: Timestamp,
    turnsWithoutProgress: Count,
  }),
]);
export type StuckReason = z.infer<typeof StuckReason>;

/** The commands that can get a Stuck batch moving again. */
export const StuckOption = z.enum(['answer', 'retry', 'skip', 'recipe', 'rewind', 'cancel']);
export type StuckOption = z.infer<typeof StuckOption>;

/** What a Conditioning batch waits for: a merge, a release or a sibling batch. */
export const WaitCondition = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('merge'), pullRequest: PullRequestUrl }),
  z.strictObject({
    kind: z.literal('release'),
    repo: Repo,
    package: NonEmpty,
    minVersion: NonEmpty,
  }),
  z.strictObject({ kind: z.literal('sibling'), batchId: BatchId }),
]);
export type WaitCondition = z.infer<typeof WaitCondition>;

const step = { batchId: BatchId, stepId: StepId, attempt: Attempt };

const orderDecomposed = z
  .strictObject({
    type: z.literal('order.decomposed'),
    batchId: BatchId,
    // Limits for a model-written breakdown; they also bound the cost of the checks below.
    subOrders: z.array(SubOrderRef).min(1).max(100),
    dependencies: z.array(Dependency).max(1000),
  })
  .superRefine(({ subOrders, dependencies }, ctx) => {
    const issues = new Set(subOrders.map((subOrder) => subOrder.issue));
    if (issues.size !== subOrders.length) {
      ctx.addIssue({ code: 'custom', message: 'Sub-orders must be unique', path: ['subOrders'] });
    }
    dependencies.forEach(({ subOrder, blockedBy }, i) => {
      if (!issues.has(subOrder) || !issues.has(blockedBy)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Must name sub-orders of this breakdown',
          path: ['dependencies', i],
        });
      }
    });
    if (hasCycle(dependencies)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must not form a cycle: those sub-orders would wait for each other forever',
        path: ['dependencies'],
      });
    }
  });

// Removes sub-orders that wait for nothing still pending until none are left; whatever remains waits in a cycle.
function hasCycle(dependencies: Dependency[]): boolean {
  let pending = dependencies;
  for (;;) {
    const waiting = new Set(pending.map((dependency) => dependency.subOrder));
    const next = pending.filter((dependency) => waiting.has(dependency.blockedBy));
    if (next.length === 0) return false;
    if (next.length === pending.length) return true;
    pending = next;
  }
}

// A human's choice records the surface it came from (ADR 0019); a label's or the router's has none.
const chosen = {
  type: z.literal('batch.recipe_chosen'),
  batchId: BatchId,
  recipe: NonEmpty,
  reason: NonEmpty,
};
const recipeChosen = z.discriminatedUnion('by', [
  z.strictObject({ ...chosen, by: z.enum(['label', 'router']) }),
  z.strictObject({ ...chosen, by: z.literal('human'), via: Surface }),
]);

export const Event = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('batch.ordered'),
    batchId: BatchId,
    order: OrderRef,
    parentBatchId: BatchId.optional(),
  }),
  recipeChosen,
  z.strictObject({ type: z.literal('step.scheduled'), ...step, deadlineAt: Timestamp }),
  // `session` is required for brewer and session steps; the schema cannot tell the step kind.
  z.strictObject({ type: z.literal('step.started'), ...step, session: SessionRef.optional() }),
  z.strictObject({
    type: z.literal('step.finished'),
    ...step,
    outcome: StepOutcome,
    usage: Usage.optional(),
  }),
  z.strictObject({
    type: z.literal('input.received'),
    batchId: BatchId,
    stepId: StepId,
    by: NonEmpty,
    via: Surface,
    answers: z.array(Answer).min(1),
  }),
  z.strictObject({
    type: z.literal('batch.stuck'),
    batchId: BatchId,
    reason: StuckReason,
    options: z
      .array(StuckOption)
      .min(1)
      .refine((options) => new Set(options).size === options.length, 'Must be unique'),
    // A Stuck batch waits for a human, never silently: the reminder is its deadline (ADR 0025).
    remindAt: Timestamp,
  }),
  z.strictObject({
    type: z.literal('batch.resumed'),
    batchId: BatchId,
    by: NonEmpty,
    via: Surface,
    action: z.enum(['retry', 'skip', 'recipe', 'answer']),
  }),
  orderDecomposed,
  z.strictObject({
    type: z.literal('batch.waiting'),
    batchId: BatchId,
    on: WaitCondition,
    remindAt: Timestamp,
  }),
  z.strictObject({
    type: z.literal('bottle.opened'),
    bottleId: Id,
    repo: Repo,
    subOrders: z.array(IssueNumber).min(1),
    pullRequest: PullRequestUrl,
  }),
  z.strictObject({
    type: z.literal('release.observed'),
    repo: Repo,
    package: NonEmpty,
    version: NonEmpty,
  }),
  z.strictObject({
    type: z.literal('batch.rewound'),
    batchId: BatchId,
    toStepId: StepId,
    by: NonEmpty,
    via: Surface,
    shas: z.record(Repo, CommitSha),
  }),
  z.strictObject({
    type: z.literal('batch.on_tap'),
    batchId: BatchId,
    pullRequests: z.array(PullRequestUrl).min(1),
  }),
  z.strictObject({
    type: z.literal('batch.cancelled'),
    batchId: BatchId,
    by: NonEmpty,
    via: Surface,
  }),
  // The idempotency ledger for external side effects (invariant I4).
  z.strictObject({ type: z.literal('effect.applied'), key: EffectKeyText, result: z.unknown() }),
]);
export type Event = z.infer<typeof Event>;
