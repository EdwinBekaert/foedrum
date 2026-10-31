// The plan comment of an order (ADR 0233): the latest succeeded plan of its batch on the order's
// issue, laid out for review (ADR 0275), its edits as revisions in the ledger,
// `[batchId, "plan.<n>"]`, each found by its marker on the Brewery's own comment before it is
// applied (ADR 0033).

import type { IsCommit } from '../formats/secrets.ts';
import { type PlannedSubOrder, type PlanReport, planOf } from '../schemas/plan.ts';
import type { StatusRevision } from '../schemas/status-comment.ts';
import { breweryIssueOf } from './claim-orders.ts';
import {
  commentRevisions,
  cutForComment,
  type DueRevision,
  longestComment,
} from './comment-revisions.ts';
import type { DriverEffects } from './driver.ts';
import type { Batch, State } from './fold.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { digestOf, knownCommits, quoted } from './pull-request.ts';
import { outDocLink } from './state-branch.ts';
import {
  code,
  link as linked,
  plain,
  planNextStep,
  type StatusComments,
} from './status-comment.ts';

/** The start of a plan comment's first line, before its batch; a status comment's never has it. */
export const PLAN_HEADING = '### Foedrum · plan of batch';

/** A text the brewer of `stepId` wrote, on one line, or a fixed line when it looks like a secret. */
type Told = (text: string) => string;

/** A sub-order's name: its id and its title. */
const named = ({ id, title }: PlannedSubOrder, told: Told): string =>
  `${code(told(id))}: ${plain(told(title))}`;

/** A row of the summary table (#658): what to take in at a glance, the rest in its section. */
const row = (subOrder: PlannedSubOrder, told: Told): string => {
  const { size, dependencies, recipe, ready } = subOrder;
  const waits =
    dependencies.length === 0
      ? 'none'
      : dependencies.map(({ on, kind }) => `${code(told(on))} (${kind})`).join(', ');
  const cells = [
    named(subOrder, told),
    `about ${size.lines} lines`,
    code(told(recipe)),
    waits,
    ready ? 'yes' : 'no',
  ];
  return `| ${cells.join(' | ')} |`;
};

/**
 * A sub-order's section (#658): what it builds, when it is done, why its recipe, why it is not
 * ready, and its touched paths folded away, since a list of twenty paths is read only on demand.
 */
const section = (subOrder: PlannedSubOrder, told: Told): string[] => {
  const { repo, size, doneWhen, touches, recipe, why } = subOrder;
  const off =
    subOrder.testFirst === false
      ? `; test-first off: ${plain(told(subOrder.testFirstOff ?? ''))}`
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
    ...(subOrder.ready ? [] : [`- Not ready: ${plain(told(subOrder.refinement ?? ''))}`]),
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
  fullPlan?: string,
  /** Whether the batch waits Stuck for a review of this plan, which the last line says what to do with. */
  waitsForReview = false,
): string => {
  const told: Told = (text) => withoutSecrets(text, stepId, isCommit);
  const { subOrders, alternatives } = plan;
  // First, and kept by a cut: the full plan, its assumptions among it, each whole (#658).
  const top = [
    `${PLAN_HEADING} ${code(batchId)}`,
    ...(fullPlan === undefined ? [] : ['', `Full plan: ${linked(fullPlan)}`]),
  ];
  const table = [
    '**Sub-orders**',
    '',
    '| Sub-order | Size | Recipe | Depends on | Ready |',
    '| --- | --- | --- | --- | --- |',
    ...subOrders.map((subOrder) => row(subOrder, told)),
  ];
  // A graph of one node says nothing the table does not (#658).
  const order = subOrders.length < 2 ? [] : [['**Order**', '', ...graph(subOrders, told)]];
  const sections = subOrders.map((subOrder) => section(subOrder, told));
  const others =
    alternatives === undefined
      ? []
      : [
          [
            '**Alternatives**',
            '',
            ...alternatives.considered.map(
              ({ cut, whyNot }) => `- ${plain(told(cut))}: ${plain(told(whyNot))}`,
            ),
            '',
            `Chosen because: ${plain(told(alternatives.whyThis))}`,
          ],
        ];
  // Filled by the plan lenses (#587) and the gate (#588).
  const after = [
    ['**Review**', '', 'None yet.'],
    ['**Gate**', '', 'None yet.'],
  ];
  const joined = (parts: string[][]): string => parts.map((lines) => lines.join('\n')).join('\n\n');
  const head = `${top.join('\n')}\n\n`;
  // Last, and kept by a cut: what to do next, while the plan waits for its review.
  const next = waitsForReview ? `\n\nNext: ${planNextStep(batchId, code)}` : '';
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

/** The plan of the latest attempt of `batch` that succeeded with one, its step and attempt. */
export const latestPlan = (
  batch: Batch,
): { stepId: string; attempt: number; plan: PlanReport } | undefined => {
  for (const { stepId, attempt } of [...(batch.path ?? [])].reverse()) {
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
 * when its latest plan's text is not the one the comment shows, else none.
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
  if (issue === undefined || latest === undefined) return undefined;
  const { next, latest: own } = revisions.latest(state, batchId);
  const previous = own ?? orderRevision(state, batch, issue);
  const { stepId, attempt, plan } = latest;
  const fullPlan =
    stateBranchUrl === undefined
      ? undefined
      : outDocLink(stateBranchUrl, { batchId, stepId, attempt }, true);
  const { lane } = batch;
  const review = lane.kind === 'stuck' && lane.reason.kind === 'plan_review';
  const text = renderPlan(batchId, stepId, plan, knownCommits(state, batchId), fullPlan, review);
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
 * whenever its text changed, edited in place, a later batch of the order editing the same comment.
 * No limit a minute: a plan changes only when a plan step succeeds (ADR 0233).
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
