// The plan comment of an order (ADR 0233): the latest succeeded plan of its batch as a table and a
// graph on the order's issue, its edits as revisions in the ledger, `[batchId, "plan.<n>"]`, each
// found by its marker on the Brewery's own comment before it is applied (ADR 0033).

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
import { code, plain, type StatusComments } from './status-comment.ts';

/** A text the brewer of `stepId` wrote, on one line, or a fixed line when it looks like a secret. */
type Told = (text: string) => string;

const row = (subOrder: PlannedSubOrder, told: Told): string => {
  const { id, title, repo, size, doneWhen, touches, dependencies, recipe, why } = subOrder;
  const touched = touches
    .map(({ path, new: fresh }) => `${plain(told(path))}${fresh === true ? ' (new)' : ''}`)
    .join(', ');
  const waits =
    dependencies.length === 0
      ? 'none'
      : dependencies.map(({ on, kind }) => `${code(told(on))} (${kind})`).join(', ');
  const off =
    subOrder.testFirst === false
      ? `; test-first off: ${plain(told(subOrder.testFirstOff ?? ''))}`
      : '';
  const ready = subOrder.ready ? 'yes' : `no: ${plain(told(subOrder.refinement ?? ''))}`;
  const cells = [
    `${code(told(id))}: ${plain(told(title))}`,
    plain(repo),
    `about ${size.lines} lines: ${plain(told(size.mechanism))}`,
    plain(told(doneWhen)),
    touched,
    waits,
    `${code(told(recipe))}: ${plain(told(why))}${off}`,
    ready,
  ];
  return `| ${cells.join(' | ')} |`;
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
): string => {
  const told: Told = (text) => withoutSecrets(text, stepId, isCommit);
  const { subOrders, alternatives } = plan;
  const title = [`### Foedrum · plan of batch ${code(batchId)}`];
  const table = [
    '**Sub-orders**',
    '',
    '| Sub-order | Repository | Size | Done when | Touches | Depends on | Recipe | Ready |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...subOrders.map((subOrder) => row(subOrder, told)),
  ];
  const order = ['**Order**', '', ...graph(subOrders, told)];
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
  const joined = (sections: string[][]): string =>
    sections.map((lines) => lines.join('\n')).join('\n\n');
  const text = joined([title, table, order, ...others, ...after]);
  if (text.length <= longestComment) return text;
  // The graph goes first, so a cut never leaves its block open.
  const left = ['**Order**', '', 'The graph is left out: GitHub keeps comments shorter.'];
  return cutForComment(joined([title, table, left, ...others, ...after]));
};

const revisions = commentRevisions('plan', 'plan comment');

/** The plan of the latest attempt of `batch` that succeeded with one, and its step. */
const latestPlan = (batch: Batch): { stepId: string; plan: PlanReport } | undefined => {
  for (const { stepId, attempt } of [...(batch.path ?? [])].reverse()) {
    const ended = batch.steps.get(stepId)?.attempts.get(attempt);
    if (ended?.phase !== 'finished' || ended.outcome.kind !== 'succeeded') continue;
    const plan = planOf(ended.outcome.output);
    if (plan !== undefined) return { stepId, plan };
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
 * The revision of the plan comment of `batchId` that the recorded events call for: the next one
 * when its latest plan's text is not the one the comment shows, else none.
 */
const planDue = (state: State, batchId: string): DueRevision | undefined => {
  const batch = state.batches.get(batchId);
  if (batch === undefined) return undefined;
  const issue = breweryIssueOf(state, batch);
  const latest = latestPlan(batch);
  if (issue === undefined || latest === undefined) return undefined;
  const { next, latest: own } = revisions.latest(state, batchId);
  const previous = own ?? orderRevision(state, batch, issue);
  const text = renderPlan(batchId, latest.stepId, latest.plan, knownCommits(state, batchId));
  const digest = digestOf(text);
  if (own?.digest === digest) return undefined;
  const due = { key: revisions.keyOf(batchId, next), issue, text, digest };
  return previous === undefined ? due : { ...due, previous };
};

export interface PlanEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  comments: StatusComments;
}

/**
 * The plan comment of every order whose batch has a succeeded plan, for the driver: a revision
 * whenever its text changed, edited in place, a later batch of the order editing the same comment.
 * No limit a minute: a plan changes only when a plan step succeeds (ADR 0233).
 */
export const planEffects = (options: PlanEffectsOptions): DriverEffects => {
  const { brewery, comments } = options;
  const plan = revisions.effects(brewery, comments);
  return {
    due: (state, batchId) => {
      const due = planDue(state, batchId);
      return due === undefined ? [] : [plan.due(due)];
    },
    target: plan.target,
  };
};
