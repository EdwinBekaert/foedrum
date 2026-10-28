// The plan comment of an order (ADR 0233): the latest succeeded plan of its batch as a table and a
// graph on the order's issue, its edits as revisions in the ledger, `[batchId, "plan.<n>"]`, each
// found by its marker on the Brewery's own comment before it is applied (ADR 0033).

import type { IsCommit } from '../formats/secrets.ts';
import { type PlannedSubOrder, type PlanReport, planOf } from '../schemas/plan.ts';
import { StatusRevision } from '../schemas/status-comment.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import { effectMarker } from './claim-effects.ts';
import { breweryIssueOf } from './claim-orders.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey, numberedEffects } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { Batch, State } from './fold.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { digestOf, knownCommits, quoted } from './pull-request.ts';
import { code, plain, type StatusComments } from './status-comment.ts';

/**
 * How long the text may be: below GitHub's 65,536 characters for a comment, with room for the
 * marker, as the status comment's.
 */
const longestText = 60_000;

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
  if (text.length <= longestText) return text;
  // The graph goes first, so a cut never leaves its block open.
  const left = ['**Order**', '', 'The graph is left out: GitHub keeps comments shorter.'];
  const shorter = joined([title, table, left, ...others, ...after]);
  if (shorter.length <= longestText) return shorter;
  // Whole lines only, so no escape or entity is cut in half.
  const cutNote = '\n\n… the rest is cut: GitHub keeps comments shorter.';
  const kept = shorter.slice(0, longestText - cutNote.length);
  return `${kept.slice(0, kept.lastIndexOf('\n'))}${cutNote}`;
};

const revisionKey = (batchId: string, revision: number): BatchEffectKey => ({
  batchId,
  effect: `plan.${revision}`,
});

/** The latest revision of `batchId` recorded, if any, and the number of the next. */
const latestRevision = (
  state: State,
  batchId: string,
): { next: number; latest: StatusRevision | undefined } => {
  const revisions = numberedEffects(
    state,
    (n) => revisionKey(batchId, n),
    StatusRevision,
    "a plan comment's revision",
  );
  return { next: revisions.length + 1, latest: revisions.at(-1) };
};

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
    found = latestRevision(state, other.id).latest ?? found;
  }
  return found;
};

/** A revision of a plan comment that is due. */
interface DueRevision {
  key: BatchEffectKey;
  issue: number;
  text: string;
  digest: string;
  /** The revision the comment shows now; absent for the order's first. */
  previous?: StatusRevision;
}

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
  const { next, latest: own } = latestRevision(state, batchId);
  const previous = own ?? orderRevision(state, batch, issue);
  const text = renderPlan(batchId, latest.stepId, latest.plan, knownCommits(state, batchId));
  const digest = digestOf(text);
  if (own?.digest === digest) return undefined;
  const due = { key: revisionKey(batchId, next), issue, text, digest };
  return previous === undefined ? due : { ...due, previous };
};

export interface PlanEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  comments: StatusComments;
}

/** A revision's result, checked: the id comes from the code host, and the ledger keeps it. */
const revisionOf = (comment: number, digest: string): StatusRevision => {
  const parsed = StatusRevision.safeParse({ comment, digest });
  if (!parsed.success) {
    throw new Error(`The code host answered a comment id that is no positive integer: ${comment}`);
  }
  return parsed.data;
};

/**
 * The plan comment of every order whose batch has a succeeded plan, for the driver: a revision
 * whenever its text changed, edited in place, a later batch of the order editing the same comment.
 * No limit a minute: a plan changes only when a plan step succeeds (ADR 0233).
 */
export const planEffects = (options: PlanEffectsOptions): DriverEffects => {
  const { brewery, comments } = options;
  // The revision behind each key `due` gave; the driver asks `due` before it applies a key.
  const revisions = new Map<string, DueRevision>();
  const revisionFor = (key: string): DueRevision => {
    const due = revisions.get(key);
    if (due === undefined) throw new Error(`No plan comment revision ${key} is due`);
    return due;
  };
  // The comment that already shows the revision of `key`, by the text before its marker.
  const shown = (comment: number, body: string, marker: string) => ({
    result: revisionOf(comment, digestOf(body.slice(0, -marker.length).trimEnd())),
  });
  const target: EffectTarget = {
    find: async (key, signal) => {
      const due = revisionFor(key);
      const marker = effectMarker(key);
      if (due.previous !== undefined) {
        const body = await comments.read(brewery, due.previous.comment, signal);
        // Still there: a run before would have edited it, not made another.
        if (body !== undefined) {
          return body.endsWith(marker) ? shown(due.previous.comment, body, marker) : undefined;
        }
      }
      const found = await comments.find(brewery, due.issue, marker, signal);
      return found === undefined ? undefined : shown(found.id, found.body, marker);
    },
    apply: async (key, signal) => {
      const due = revisionFor(key);
      const body = `${due.text}\n\n${effectMarker(key)}`;
      if (due.previous !== undefined) {
        const edited = await comments.edit(brewery, due.previous.comment, body, signal);
        if (edited === 'edited') return revisionOf(due.previous.comment, due.digest);
      }
      // The order's first plan, or the comment was deleted by hand: it is made again.
      return revisionOf(await comments.create(brewery, due.issue, body, signal), due.digest);
    },
  };
  return {
    due: (state, batchId) => {
      const due = planDue(state, batchId);
      if (due === undefined) return [];
      revisions.set(effectKey.encode(due.key), due);
      return [due.key];
    },
    target,
  };
};
