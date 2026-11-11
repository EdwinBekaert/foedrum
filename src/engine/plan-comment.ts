// The plan comment of an order (ADR 0233): the latest succeeded plan of its batch on the order's
// issue, laid out for review (ADR 0275), its edits as revisions in the ledger,
// `[batchId, "plan.<n>"]`, each found by its marker on the Brewery's own comment before it is
// applied (ADR 0033).

import type { IsCommit } from '../formats/secrets.ts';
import type { PlanOrigin, Surface } from '../schemas/events.ts';
import type { TastingFinding } from '../schemas/out-doc.ts';
import {
  type PlanAlternatives,
  type PlannedSubOrder,
  type PlanReport,
  planOf,
} from '../schemas/plan.ts';
import type { StatusRevision } from '../schemas/status-comment.ts';
import { breweryIssueOf, calledAs } from './claim-orders.ts';
import {
  commentRevisions,
  cutForComment,
  type DueRevision,
  longestComment,
} from './comment-revisions.ts';
import type { DriverEffects } from './driver.ts';
import type { Approval, Batch, State } from './fold.ts';
import { lensRounds, roundFindings, withDispositions } from './lens-rounds.ts';
import { stuckNext } from './next-step.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { type OpenedSubIssue, openedSubIssues, SKIPS_TEST_FIRST } from './plan-applied.ts';
import { digestOf, findingText, knownCommits, quoted } from './pull-request.ts';
import { outDocLink, outDocPlace } from './state-branch.ts';
import { code, labelled, plain, type StatusComments } from './status-comment.ts';
import { tryName } from './words.ts';

/** The start of a plan comment's first line, before its batch; a status comment's never has it. */
export const PLAN_HEADING = '### Foedrum · plan of batch';

/** A text the brewer of `stepId` wrote, on one line, or a fixed line when it looks like a secret. */
type Told = (text: string) => string;

/** A sub-order's name: its id and its title. */
const named = ({ id, title }: PlannedSubOrder, told: Told): string =>
  `${code(told(id))}: ${plain(told(title))}`;

/** What a sub-order depends on, each with its kind, or `none`. */
const waitsOf = ({ dependencies }: PlannedSubOrder, told: Told): string =>
  dependencies.length === 0
    ? 'none'
    : dependencies.map(({ on, kind }) => `${code(told(on))} (${kind})`).join(', ');

/** A row of the summary table (#658): what to take in at a glance, the rest in its section. */
const row = (subOrder: PlannedSubOrder, told: Told): string => {
  const { size, recipe, ready } = subOrder;
  const cells = [
    named(subOrder, told),
    `about ${size.lines} lines`,
    code(told(recipe)),
    waitsOf(subOrder, told),
    ready ? 'yes' : 'no',
  ];
  return `| ${cells.join(' | ')} |`;
};

/**
 * A sub-order's section (#658): what it builds, when it is done, why its recipe, its security mark
 * (ADR 0322), why it is not ready, the `more` lines its caller adds, and its touched paths folded away, since a list of
 * twenty paths is read only on demand.
 */
const section = (subOrder: PlannedSubOrder, told: Told, more: readonly string[] = []): string[] => {
  const { repo, size, doneWhen, touches, recipe, why } = subOrder;
  const off =
    subOrder.testFirst === false
      ? `; test-first off, ${SKIPS_TEST_FIRST}: ${plain(told(subOrder.testFirstOff ?? ''))}`
      : '';
  const paths = touches.map(
    ({ path, new: fresh }) => `- ${plain(told(path))}${fresh === true ? ' (new)' : ''}`,
  );
  return [
    `#### ${named(subOrder, told)}`,
    '',
    `- Builds in ${plain(repo)}: ${plain(told(size.mechanism))}, about ${size.lines} lines`,
    `- Done when: ${plain(told(doneWhen))}`,
    `- Recipe ${code(told(recipe))}: ${plain(told(why))}${off}`,
    ...(subOrder.securityMark === undefined
      ? []
      : [`- Security: ${plain(told(subOrder.securityMark))}`]),
    ...(subOrder.ready ? [] : [`- Not ready: ${plain(told(subOrder.refinement ?? ''))}`]),
    ...more,
    '',
    `<details><summary>Touches ${touches.length} ${touches.length === 1 ? 'path' : 'paths'}</summary>`,
    '',
    ...paths,
    '',
    '</details>',
  ];
};

/**
 * The graph of the sub-orders' order (ADR 0180): each id replaced by a node id of the engine's,
 * every label quoted, and a backtick written as Mermaid's entity, so no label ends the block.
 */
const graph = (subOrders: readonly PlannedSubOrder[], told: Told): string[] => {
  const nodes = new Map(subOrders.map(({ id }, at) => [id, `s${at + 1}`]));
  const label = (text: string): string =>
    quoted(text.replace(/\s+/g, ' ').trim()).replaceAll('`', '#96;');
  const edges = subOrders.flatMap(({ id, dependencies }) =>
    dependencies.map(({ on, kind }) => `  ${nodes.get(on)} -->|"${kind}"| ${nodes.get(id)}`),
  );
  return [
    '```mermaid',
    'flowchart LR',
    ...subOrders.map(
      ({ id, title }) => `  ${nodes.get(id)}[${label(`${told(id)}: ${told(title)}`)}]`,
    ),
    ...edges,
    '```',
  ];
};

/** The other cuts a plan considered, and why this one. */
const alternativesOf = (alternatives: PlanAlternatives, told: Told): string[] => [
  '**Alternatives**',
  '',
  ...alternatives.considered.map(
    ({ cut, whyNot }) => `- ${plain(told(cut))}: ${plain(told(whyNot))}`,
  ),
  '',
  `Chosen because: ${plain(told(alternatives.whyThis))}`,
];

/**
 * The text of the plan entry `origin` names, for a sub-order's brewers (ADR 0290): its section as
 * the plan comment shows it, with what it depends on, then the plan's alternatives. Read from the
 * attempt's recorded out doc, which the approval signed (ADR 0281), never from a worktree; throws
 * when that attempt wrote no plan holding the entry.
 */
export const planEntryText = (state: State, origin: PlanOrigin): string => {
  const { batchId, stepId, attempt, entry } = origin;
  const ended = state.batches.get(batchId)?.steps.get(stepId)?.attempts.get(attempt);
  const plan =
    ended?.phase === 'finished' && ended.outcome.kind === 'succeeded'
      ? planOf(ended.outcome.output)
      : undefined;
  const subOrder = plan?.subOrders.find(({ id }) => id === entry);
  if (plan === undefined || subOrder === undefined) {
    throw new Error(
      `the plan of batch ${batchId}, step ${stepId}#${attempt}, holds no entry ${entry}`,
    );
  }
  const isCommit = knownCommits(state, batchId);
  const told: Told = (text) => withoutSecrets(text, stepId, isCommit);
  const { alternatives } = plan;
  return [
    ...section(subOrder, told, [`- Depends on: ${waitsOf(subOrder, told)}`]),
    ...(alternatives === undefined ? [] : ['', ...alternativesOf(alternatives, told)]),
  ].join('\n');
};

/** Who chose the session that wrote a plan, from where, and when it opened (ADR 0286). */
export interface ChangedInSession {
  by: string;
  via: Surface;
  at?: string;
}

/**
 * A note a plan lens step left at gate 1 (ADR 0318): a finding of its round `attempt`, advisory or
 * still open after the rounds, or one the plan dismissed or left as there before, with its `why`.
 */
export interface ReviewNote {
  stepId: string;
  attempt: number;
  finding: TastingFinding;
  left: 'advisory' | 'open' | 'dismissed' | 'pre-existing';
  why?: string;
}

/** How many notes of one plan lens step the Review shows, as the status comment shows findings. */
const mostReviewNotes = 10;

/**
 * The notes the plan lens steps left on the plan `stepId#attempt` of `batch` (ADR 0318): of each
 * step whose latest round reviewed after that plan, in the order the steps ran, each finding the
 * plan dismissed or left as there before in an earlier round, with its why, then the latest
 * round's findings, advisory when it succeeded, still open when it ended blocked; undefined while
 * no step reviewed it. A fixed finding is in the plan, so it leaves no note.
 */
export const reviewNotes = (
  batch: Batch,
  stepId: string,
  attempt: number,
): ReviewNote[] | undefined => {
  const path = batch.path ?? [];
  const placeOf = (step: string, n: number) =>
    path.findIndex((ref) => ref.stepId === step && ref.attempt === n);
  const planned = placeOf(stepId, attempt);
  let reviewed = false;
  const notes: ReviewNote[] = [];
  for (const step of new Set(path.slice(planned + 1).map((ref) => ref.stepId))) {
    const rounds = lensRounds(batch, step);
    const latest = rounds.at(-1);
    if (latest === undefined || placeOf(step, latest.attempt) < planned) continue;
    reviewed = true;
    for (const round of rounds.slice(0, -1)) {
      for (const { finding, disposition } of withDispositions(
        roundFindings(round.ran),
        round.dispositions,
      )) {
        if (disposition === undefined || disposition.disposition === 'fixed') continue;
        notes.push({
          stepId: step,
          attempt: round.attempt,
          finding,
          left: disposition.disposition,
          why: disposition.why,
        });
      }
    }
    const left = latest.ran.outcome.kind === 'succeeded' ? 'advisory' : 'open';
    for (const finding of roundFindings(latest.ran)) {
      notes.push({ stepId: step, attempt: latest.attempt, finding, left });
    }
  }
  return reviewed ? notes : undefined;
};

/**
 * The Review section's lines (ADR 0318): `mostReviewNotes` notes of each step, then how many more,
 * a finding as its step's Taster wrote it, a why as the plan's step `planStep` wrote it, each left
 * out when it looks like a secret.
 */
const reviewLines = (
  notes: readonly ReviewNote[],
  planStep: string,
  isCommit: IsCommit,
): string[] =>
  [...Map.groupBy(notes, (note) => note.stepId)].flatMap(([stepId, ofStep]) => {
    const told = (text: string, by: string) => plain(withoutSecrets(text, by, isCommit));
    const shown = ofStep
      .slice(0, mostReviewNotes)
      .flatMap(({ attempt, finding, left, why }) => [
        `- ${code(tryName(stepId, attempt))}: ${told(findingText(finding), stepId)}, ${left}: ${told(finding.why, stepId)}`,
        ...(why === undefined ? [] : [`  - why: ${told(why, planStep)}`]),
      ]);
    const more = ofStep.length - mostReviewNotes;
    return more > 0 ? [...shown, `- ${code(stepId)}: and ${more} more`] : shown;
  });

/** The out doc of a plan: its place on the state branch, as `7-1/plan-2.md`, and its address. */
export interface FullPlan {
  place: string;
  url: string;
}

/**
 * The plan comment's text for the plan `stepId` of `batchId` wrote, without its marker: every text
 * the brewer wrote one escaped line, left out when it looks like a secret.
 */
export const renderPlan = (
  batchId: string,
  stepId: string,
  plan: PlanReport,
  isCommit: IsCommit = () => false,
  /** The out doc of the plan on the state branch, linked at the top (ADR 0266, ADR 0275). */
  fullPlan?: FullPlan,
  /** Whether the batch waits Stuck for a review of this plan, which the last line says what to do with. */
  waitsForReview = false,
  /** The sign-off of this plan, which the Gate section shows (ADR 0281). */
  approval?: Approval,
  /** The session a person's lauter opened, which wrote this plan (ADR 0286). */
  changed?: ChangedInSession,
  /** The sub-issues the approved plan opened so far, which the Gate section names (ADR 0285). */
  opened: readonly OpenedSubIssue[] = [],
  /** The notes its plan lenses left (ADR 0318); undefined while no plan lens reviewed it. */
  review?: readonly ReviewNote[],
  /** The `Next:` line of the batch that waits for the review: `stuckNext`'s, as every surface shows it (ADR 0379). */
  nextLine?: string,
  /** How its commands name its work (`calledAs`, ADR 0329). */
  called: string = batchId,
): string => {
  const told: Told = (text) => withoutSecrets(text, stepId, isCommit);
  const { subOrders, alternatives } = plan;
  // First, and kept by a cut: the full plan, its assumptions among it, each whole (#658).
  const top = [
    `${PLAN_HEADING} ${code(batchId)}`,
    ...(fullPlan === undefined ? [] : ['', `Full plan: ${labelled(fullPlan.place, fullPlan.url)}`]),
    ...(changed === undefined
      ? []
      : [
          '',
          `Changed in a session by ${plain(changed.by)} (${changed.via})${changed.at === undefined ? '' : ` at ${changed.at}`}.`,
        ]),
  ];
  const table = [
    '**Sub-orders** (each becomes one pull request)',
    '',
    '| Sub-order | Size | Recipe | Depends on | Ready |',
    '| --- | --- | --- | --- | --- |',
    ...subOrders.map((subOrder) => row(subOrder, told)),
  ];
  // A graph of one node says nothing the table does not (#658).
  const order = subOrders.length < 2 ? [] : [['**Order**', '', ...graph(subOrders, told)]];
  const sections = subOrders.map((subOrder) => section(subOrder, told));
  const others = alternatives === undefined ? [] : [alternativesOf(alternatives, told)];
  // The Review is filled by the plan lenses (ADR 0318); the Gate by approve (ADR 0281).
  // An approved plan's sub-orders that are not ready stay so until #589 corrects them.
  const notReady = subOrders.filter(({ ready }) => !ready).map(({ id }) => code(told(id)));
  const gate =
    approval !== undefined
      ? [
          `Approved by ${plain(approval.by)} (${approval.via}) at ${approval.at}.`,
          ...(opened.length === 0
            ? []
            : [
                '',
                `Sub-issues: ${opened.map(({ id, number }) => `${code(told(id))} #${number}`).join(', ')}.`,
              ]),
          ...(notReady.length === 0 ? [] : ['', `Not ready: ${notReady.join(', ')}.`]),
        ]
      : [waitsForReview ? `Waiting for ${code(`foedrum approve ${called}`)}.` : 'None yet.'];
  const after = [
    [
      '**Review**',
      '',
      ...(review === undefined
        ? ['None yet.']
        : review.length === 0
          ? ['No findings.']
          : reviewLines(review, stepId, isCommit)),
    ],
    ['**Gate** (your sign-off before anything is built)', '', ...gate],
  ];
  const joined = (parts: string[][]): string => parts.map((lines) => lines.join('\n')).join('\n\n');
  const head = `${top.join('\n')}\n\n`;
  // Last, and kept by a cut: what to do next, while the plan waits for its review.
  const next = waitsForReview && nextLine !== undefined ? `\n\n${nextLine}` : '';
  const text = joined([table, ...order, ...sections, ...others, ...after]);
  if (head.length + text.length + next.length <= longestComment) return `${head}${text}${next}`;
  // The graph goes first, so a cut never leaves its block open.
  const left =
    order.length === 0
      ? []
      : [['**Order**', '', 'The graph is left out: GitHub keeps comments shorter.']];
  const room = head.length + next.length;
  return `${head}${wholeBlocks([table, ...left, ...sections, ...others, ...after], room)}${next}`;
};

const cutNote = '… the rest is cut: GitHub keeps comments shorter.';

/**
 * The blocks of `parts` that fit below `longestComment`, less `room`, each whole, so a cut never
 * leaves a sub-order's `<details>` open over the rest; a first block too long alone is cut to
 * whole lines, as `cutForComment` cuts.
 */
const wholeBlocks = (parts: readonly string[][], room: number): string => {
  const blocks = parts.map((lines) => lines.join('\n'));
  const whole = blocks.join('\n\n');
  const most = longestComment - room;
  if (whole.length <= most) return whole;
  let kept = '';
  for (const block of blocks) {
    const tried = kept === '' ? block : `${kept}\n\n${block}`;
    if (tried.length + 2 + cutNote.length > most) break;
    kept = tried;
  }
  return kept === '' ? cutForComment(whole, room) : `${kept}\n\n${cutNote}`;
};

const revisions = commentRevisions('plan', 'plan comment');

/**
 * The plan of the latest attempt of `batch` that succeeded with one, its step and attempt; of a
 * step `include` takes, when given.
 */
export const latestPlan = (
  batch: Batch,
  include: (stepId: string) => boolean = () => true,
): { stepId: string; attempt: number; plan: PlanReport } | undefined => {
  for (const { stepId, attempt } of [...(batch.path ?? [])].reverse()) {
    if (!include(stepId)) continue;
    const ended = batch.steps.get(stepId)?.attempts.get(attempt);
    if (ended?.phase !== 'finished' || ended.outcome.kind !== 'succeeded') continue;
    const plan = planOf(ended.outcome.output);
    if (plan !== undefined) return { stepId, attempt, plan };
  }
  return undefined;
};

/**
 * The latest revision of the order's comment before `batch`'s first: of another batch of the same
 * Brewery issue, the last in the order the batches were ordered, so an order shows one plan.
 */
const orderRevision = (state: State, batch: Batch, issue: number): StatusRevision | undefined => {
  let found: StatusRevision | undefined;
  for (const other of state.batches.values()) {
    if (other.id === batch.id || breweryIssueOf(state, other) !== issue) continue;
    found = revisions.latest(state, other.id).latest ?? found;
  }
  return found;
};

/**
 * Whether a batch of the same Brewery issue, ordered after `batch`, has a succeeded plan: the
 * plan the order's comment shows from then on, so `batch`'s own is never due again (ADR 0361).
 */
const laterPlanned = (state: State, batch: Batch, issue: number): boolean => {
  let after = false;
  for (const other of state.batches.values()) {
    if (other.id === batch.id) after = true;
    else if (after && breweryIssueOf(state, other) === issue && latestPlan(other) !== undefined) {
      return true;
    }
  }
  return false;
};

/**
 * The id of the plan comment that shows the plan of `batchId`: the one its latest recorded revision
 * made or edited, else the order's, which its earlier batch made; undefined while it has none.
 */
export const planCommentOf = (state: State, batchId: string): number | undefined => {
  const batch = state.batches.get(batchId);
  if (batch === undefined) return undefined;
  const issue = breweryIssueOf(state, batch);
  if (issue === undefined || latestPlan(batch) === undefined) return undefined;
  return (revisions.latest(state, batchId).latest ?? orderRevision(state, batch, issue))?.comment;
};

/**
 * The revision of the plan comment of `batchId` that the recorded events call for: the next one
 * when its latest plan's text is not the one the comment shows, else none; none either once a
 * later batch of the order has a plan, so a changed text never puts an older plan back (ADR 0361).
 */
const planDue = (
  state: State,
  batchId: string,
  stateBranchUrl?: string,
): DueRevision | undefined => {
  const batch = state.batches.get(batchId);
  if (batch === undefined) return undefined;
  const issue = breweryIssueOf(state, batch);
  const latest = latestPlan(batch);
  if (issue === undefined || latest === undefined || laterPlanned(state, batch, issue)) {
    return undefined;
  }
  const { next, latest: own } = revisions.latest(state, batchId);
  const previous = own ?? orderRevision(state, batch, issue);
  const { stepId, attempt, plan } = latest;
  const ref = { batchId, stepId, attempt };
  const fullPlan =
    stateBranchUrl === undefined
      ? undefined
      : { place: outDocPlace(ref), url: outDocLink(stateBranchUrl, ref, true) };
  const { lane, approval } = batch;
  const review = lane.kind === 'stuck' && lane.reason.kind === 'plan_review';
  // An approved batch is on tap, which nothing leaves: its latest plan is the one approved.
  const commits = knownCommits(state, batchId);
  const ran = batch.steps.get(stepId)?.attempts.get(attempt);
  const chosen = ran?.chosen;
  const at = ran?.phase === 'finished' ? ran.interactiveSince : undefined;
  const changed =
    chosen === undefined
      ? undefined
      : { by: chosen.by, via: chosen.via, ...(at === undefined ? {} : { at }) };
  const opened = openedSubIssues(state, batchId);
  const text = renderPlan(
    batchId,
    stepId,
    plan,
    commits,
    fullPlan,
    review,
    approval,
    changed,
    opened,
    reviewNotes(batch, stepId, attempt),
    lane.kind === 'stuck' && review
      ? stuckNext(lane.reason, lane.options, calledAs(state, batch), code)
      : undefined,
    calledAs(state, batch),
  );
  const digest = digestOf(text);
  if (own?.digest === digest) return undefined;
  const due = { key: revisions.keyOf(batchId, next), issue, text, digest };
  return previous === undefined ? due : { ...due, previous };
};

export interface PlanEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  comments: StatusComments;
  /** The state branch on the code host, `https://<host>/<brewery>/blob/foedrum/state` (ADR 0266). */
  stateBranchUrl?: string;
}

/**
 * The plan comment of every order whose batch has a succeeded plan, for the driver: a revision
 * whenever its text changed, edited in place, a later batch of the order editing the same comment
 * and, once it has a plan, the only one that does (ADR 0361).
 * No limit a minute: a plan changes only when a plan step succeeds (ADR 0233), its Gate when a
 * pass opens the approved plan's sub-issues, which the driver applies before it (ADR 0285), and
 * its Review when a plan lens round ends (ADR 0318).
 */
export const planEffects = (options: PlanEffectsOptions): DriverEffects => {
  const { brewery, comments, stateBranchUrl } = options;
  const plan = revisions.effects(brewery, comments);
  return {
    due: (state, batchId) => {
      const due = planDue(state, batchId, stateBranchUrl);
      return due === undefined ? [] : [plan.due(due)];
    },
    target: plan.target,
  };
};
