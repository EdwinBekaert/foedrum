// Events: the append-only log that state is folded from (architecture §4.1, ADR 0002, ADR 0019).

import { PathSafeId } from './ids.ts';
import { BlockerKind } from './out-doc.ts';
import { CheckName } from './primitives.ts';
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
export const PullRequestUrl = z
  .url({ protocol: /^https$/ })
  // Checked on the parsed URL: the parser also finds credentials in `HTTPS://`, `https:\\` or `https:/`.
  .refine((url) => {
    const parsed = URL.parse(url); // null when z.url already rejected it; zod runs this anyway
    return parsed?.username === '' && parsed.password === '';
  }, 'Must not contain credentials');

/** Where a command or answer came from (ADR 0019). */
export const Surface = z.enum(['plugin', 'terminal', 'comment', 'dashboard']);
export type Surface = z.infer<typeof Surface>;

/**
 * The Claude Code session of a brewer's attempt, so any action can resume the right session
 * (ADR 0019): the id the driver chose before claude started, and the worktree it runs in
 * (ADR 0116). `resumes`: the session it continues; `fallback`: why it started a new session where
 * its brewer would have resumed one (ADR 0117).
 */
export const SessionRef = z.strictObject({
  id: Id,
  resumes: Id.optional(),
  worktree: NonEmpty,
  fallback: NonEmpty.optional(),
});
export type SessionRef = z.infer<typeof SessionRef>;

/**
 * What claude reported in its init event: its version and the model it ran, for diagnosis
 * (ADR 0116). A run that ended before the init has none.
 */
export const ClaudeReport = z.strictObject({
  version: NonEmpty,
  model: NonEmpty,
});
export type ClaudeReport = z.infer<typeof ClaudeReport>;

/**
 * The worktree an attempt was given (ADR 0029): in which repository, where, on which branch and at
 * which commit, so it survives restarts and a resumed attempt can get it back (ADR 0019). The path
 * and branch say where it was and nothing acts on them: `recreate` builds both from the attempt
 * again and takes only the commit (ADR 0037).
 */
export const WorktreeRef = z.strictObject({
  repo: Repo,
  path: NonEmpty,
  branch: NonEmpty,
  commit: CommitSha,
});
export type WorktreeRef = z.infer<typeof WorktreeRef>;

/**
 * The issue of an order or sub-order: an issue in the Brewery, or a claimed issue of the target
 * repository `repo`, whose order is a Brewery issue (ADR 0043, ADR 0144).
 */
export const OrderRef = z.strictObject({ issue: IssueNumber, repo: Repo.optional() });
export type OrderRef = z.infer<typeof OrderRef>;

/**
 * The route back that scheduled an attempt (ADR 0064): from the step whose check failed
 * (`onFail`) or whose brewer was blocked by findings (`onBlocked`).
 */
export const ScheduleRoute = z.strictObject({ from: StepId, why: z.enum(['failed', 'findings']) });
export type ScheduleRoute = z.infer<typeof ScheduleRoute>;

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

/** The most of a check's output a gravity reading keeps: its end, where failures show (ADR 0069). */
export const MAX_TAIL_LENGTH = 4000;
const Tail = z.string().max(MAX_TAIL_LENGTH);
// A named check, or none for a Brewery's literal command or the repository's setup, which says so
// (ADR 0140); the command line as it ran; and where no sandbox held it, that it ran unsandboxed:
// a check or a setup on native Windows (ADR 0076, ADR 0158).
const ran = {
  check: CheckName.optional(),
  setup: z.literal(true).optional(),
  command: NonEmpty,
  unsandboxed: z.literal(true).optional(),
};

/** What one check of a check step did (ADR 0069). */
export const GravityReading = z.discriminatedUnion('result', [
  // The repository has no such check (null in foedrum.jsonc): skipped, never guessed (ADR 0023).
  z.strictObject({ result: z.literal('skipped'), check: CheckName }),
  z.strictObject({ result: z.literal('exited'), ...ran, exitCode: z.int(), tail: Tail }),
  // The process runner killed its tree: the step's deadline, a stop, or too much output.
  z.strictObject({
    result: z.literal('killed'),
    ...ran,
    killed: z.enum(['timed-out', 'stopped', 'too-much-output']),
    tail: Tail,
  }),
  // A signal the runner did not send ended it: a crash, an abort, the OOM killer.
  z.strictObject({ result: z.literal('signaled'), ...ran, signal: NonEmpty, tail: Tail }),
  // It could not start; the tail says why.
  z.strictObject({ result: z.literal('unstarted'), ...ran, tail: Tail }),
]);
export type GravityReading = z.infer<typeof GravityReading>;

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
  // No file write or commit since `lastProgressAt`, for `turnsWithoutProgress` turns (ADR 0027).
  z.strictObject({
    kind: z.literal('stalled'),
    stepId: StepId,
    lastProgressAt: Timestamp,
    turnsWithoutProgress: Count,
  }),
  // An Ordered batch that nothing routed by its routing deadline (ADR 0032).
  z.strictObject({ kind: z.literal('routing'), deadlineAt: Timestamp }),
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

// A human's choice records who issued it and from where (ADR 0019); a label's or the router's has neither.
const chosen = {
  type: z.literal('batch.recipe_chosen'),
  batchId: BatchId,
  recipe: NonEmpty,
  reason: NonEmpty,
};
const recipeChosen = z.discriminatedUnion('source', [
  z.strictObject({ ...chosen, source: z.enum(['label', 'router']) }),
  z.strictObject({ ...chosen, source: z.literal('human'), by: NonEmpty, via: Surface }),
]);

export const Event = z.discriminatedUnion('type', [
  z
    .strictObject({
      type: z.literal('batch.ordered'),
      batchId: BatchId,
      order: OrderRef,
      parentBatchId: BatchId.optional(),
      // An Ordered batch waits to be routed, never silently: this is its deadline (ADR 0032).
      routeBy: Timestamp,
      // Who ordered it by hand, and from where (`foedrum order`, ADR 0105); absent for the intake's
      // orders and sub-orders.
      by: NonEmpty.optional(),
      via: Surface.optional(),
    })
    .refine(
      ({ by, via }) => (by === undefined) === (via === undefined),
      'Must name both who ordered it (by) and from where (via), or neither',
    ),
  recipeChosen,
  // `route`: the onFail or onBlocked route that scheduled the attempt, which counts its rounds.
  // `retry`: it runs because the attempt before it failed, so a brewer that resumes continues
  // that attempt's session (ADR 0117). `answered`: it runs because a human answered the
  // questions of the attempt before it, so a brewer that resumes continues that session with the
  // answers (ADR 0118).
  z.strictObject({
    type: z.literal('step.scheduled'),
    ...step,
    deadlineAt: Timestamp,
    route: ScheduleRoute.optional(),
    retry: z.literal(true).optional(),
    answered: z.literal(true).optional(),
  }),
  // The step's `when` was false when the batch reached it, so it did not run (ADR 0064).
  z.strictObject({
    type: z.literal('step.skipped'),
    batchId: BatchId,
    stepId: StepId,
    when: NonEmpty,
  }),
  // `session` is required for brewer and session steps; the schema cannot tell the step kind.
  // `worktree` is the one this attempt was given; a resumed session's attempt runs in the
  // worktree of the attempt it continues, named by `session.worktree`, and has none (ADR 0029).
  z.strictObject({
    type: z.literal('step.started'),
    ...step,
    session: SessionRef.optional(),
    worktree: WorktreeRef.optional(),
  }),
  // `readings`: a check step's, one per check it read, in order (ADR 0069), or a brewer's, its
  // repository's setup's (ADR 0163). `claude`: a brewer's, once claude's init came (ADR 0116).
  z.strictObject({
    type: z.literal('step.finished'),
    ...step,
    outcome: StepOutcome,
    usage: Usage.optional(),
    readings: z.array(GravityReading).min(1).optional(),
    claude: ClaudeReport.optional(),
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
    // A retry of a batch Stuck on routing sends it back to Ordered with this deadline (ADR 0032).
    routeBy: Timestamp.optional(),
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
    // None while recipes end without an openPullRequest action (ADR 0059).
    pullRequests: z.array(PullRequestUrl),
  }),
  z.strictObject({
    type: z.literal('batch.cancelled'),
    batchId: BatchId,
    by: NonEmpty,
    via: Surface,
  }),
  // A person handed the batch from the driver `from` to the driver `to` (ADR 0124). `until`: when
  // `from`'s lease would have expired, before which no driver applies an effect of the batch.
  z.strictObject({
    type: z.literal('batch.taken_over'),
    batchId: BatchId,
    by: NonEmpty,
    via: Surface,
    from: NonEmpty,
    to: NonEmpty,
    until: Timestamp,
    // The step whose session `to` resumes: `from` stops its run of that step (ADR 0127).
    resumes: StepId.optional(),
  }),
  // A pull request of the batch was merged or closed, as the intake saw it; recorded once (#103).
  z.strictObject({
    type: z.literal('pull_request.ended'),
    batchId: BatchId,
    pullRequest: PullRequestUrl,
    state: z.enum(['merged', 'closed']),
  }),
  // The idempotency ledger for external side effects (invariant I4).
  z.strictObject({ type: z.literal('effect.applied'), key: EffectKeyText, result: z.unknown() }),
]);
export type Event = z.infer<typeof Event>;
