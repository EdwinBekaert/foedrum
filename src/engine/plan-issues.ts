// An approved plan as Brewery sub-issues (ADR 0285): the driver's effects that open each sub-order's
// issue, add it under its order and link it to what blocks it, each through the ledger and found
// before it is applied (ADR 0033), and the `order.decomposed` that follows the last of them.

import type { Event } from '../schemas/events.ts';
import type { PlannedSubOrder } from '../schemas/plan.ts';
import { effectMarker } from './claim-effects.ts';
import type { RecordedEvent } from './decide.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { Batch, State } from './fold.ts';
import { withoutSecrets } from './out-doc-text.ts';
import {
  approvedPlan,
  issueKey,
  linkKey,
  type OpenedIssue,
  OpenedIssue as OpenedIssueSchema,
  openedIssue,
  parentKey,
} from './plan-applied.ts';
import { code, plain } from './status-comment.ts';
import type { SubIssues } from './sub-issues.ts';

export { type OpenedSubIssue, openedSubIssues } from './plan-applied.ts';

/** The label of a sub-order the plan marked not ready: the intake leaves it to a person (ADR 0285). */
export const NEEDS_REFINEMENT = 'needs-refinement';

export interface PlanIssueEffectsOptions {
  /** The Brewery's issues and their links. */
  subIssues: SubIssues;
  /** How long one effect may take; the driver's default when left out (`DriverEffects`). */
  deadlineMs?: number;
}

/** What an approved, not yet decomposed Brewery order's batch applies, or undefined. */
const applying = (state: State, batchId: string) => {
  const batch = state.batches.get(batchId);
  // Sub-orders are Brewery issues of a Brewery order (ADR 0043); one breakdown per approval.
  if (batch === undefined || batch.repo !== undefined || batch.decomposed === true) return;
  if (state.subOrders.has(batch.issue)) return;
  const approved = approvedPlan(batch);
  return approved === undefined ? undefined : { batch, ...approved };
};

/** The sub-issue's text: what it builds, when it is done, why its recipe, and its order. */
const bodyOf = (batch: Batch, stepId: string, subOrder: PlannedSubOrder): string => {
  const told = (text: string): string => plain(withoutSecrets(text, stepId, () => false));
  const { id, repo, size, doneWhen, recipe, why } = subOrder;
  return [
    `Sub-order ${code(id)} of #${batch.issue}, from the plan of batch ${code(batch.id)} (ADR 0285).`,
    '',
    `- Builds in ${plain(repo)}: ${told(size.mechanism)}, about ${size.lines} lines`,
    `- Done when: ${told(doneWhen)}`,
    `- Recipe ${code(recipe)}: ${told(why)}`,
    ...(subOrder.ready ? [] : [`- Not ready: ${told(subOrder.refinement ?? '')}`]),
  ].join('\n');
};

/** Applies `write`, and when it is refused, reads whether it is there all the same. */
const added = async (write: () => Promise<void>, holds: () => Promise<boolean>): Promise<null> => {
  try {
    await write();
  } catch (error) {
    // A repeat answers a refusal (422 on GitHub), and the list shows it (trackers.md).
    if (!(await holds())) throw error;
  }
  return null;
};

/**
 * The effects that apply the plan an approval signed off, for the driver, in their order: each
 * sub-order's issue, then its place under the order once that issue is in the ledger, then each
 * "blocked by" link once both its issues are; and `order.decomposed` once all are (ADR 0285).
 */
export const planIssueEffects = (options: PlanIssueEffectsOptions): DriverEffects => {
  const { subIssues, deadlineMs } = options;
  const targets = new Map<string, EffectTarget>();
  const issueTarget = (batch: Batch, stepId: string, subOrder: PlannedSubOrder): EffectTarget => ({
    find: async (key, signal) => {
      const found = await subIssues.findIssue(effectMarker(key), signal);
      return found === undefined ? undefined : { result: OpenedIssueSchema.parse(found) };
    },
    apply: async (key, signal) => {
      const labels = [`recipe:${subOrder.recipe}`, ...(subOrder.ready ? [] : [NEEDS_REFINEMENT])];
      const title = withoutSecrets(subOrder.title, stepId, () => false);
      const body = `${bodyOf(batch, stepId, subOrder)}\n\n${effectMarker(key)}`;
      return OpenedIssueSchema.parse(await subIssues.openIssue(title, body, labels, signal));
    },
  });
  const parentTarget = (order: number, child: OpenedIssue): EffectTarget => {
    const holds = async (signal?: AbortSignal) =>
      (await subIssues.subIssues(order, signal)).some(({ number }) => number === child.number);
    return {
      find: async (_key, signal) => ((await holds(signal)) ? { result: null } : undefined),
      apply: (_key, signal) =>
        added(
          () => subIssues.addSubIssue(order, child.id, signal),
          () => holds(signal),
        ),
    };
  };
  const linkTarget = (blocked: OpenedIssue, blocker: OpenedIssue): EffectTarget => {
    const holds = async (signal?: AbortSignal) =>
      (await subIssues.blockedBy(blocked.number, signal)).some(
        ({ number }) => number === blocker.number,
      );
    return {
      find: async (_key, signal) => ((await holds(signal)) ? { result: null } : undefined),
      apply: (_key, signal) =>
        added(
          () => subIssues.addBlockedBy(blocked.number, blocker.id, signal),
          () => holds(signal),
        ),
    };
  };
  const targetOf = (key: string): EffectTarget => {
    const target = targets.get(key);
    if (target === undefined) throw new Error(`No plan effect ${key} is due`);
    return target;
  };

  /** Every key of the plan whose issues are in the ledger, its issues first. */
  const keysOf = (state: State, batchId: string) => {
    const applied = applying(state, batchId);
    if (applied === undefined) return undefined;
    const { batch, stepId, plan } = applied;
    const issues = new Map(
      plan.subOrders.map(({ id }) => [id, openedIssue(state, issueKey(batchId, id))]),
    );
    const due: { key: ReturnType<typeof issueKey>; target: () => EffectTarget }[] = [];
    for (const subOrder of plan.subOrders) {
      due.push({
        key: issueKey(batchId, subOrder.id),
        target: () => issueTarget(batch, stepId, subOrder),
      });
    }
    for (const { id } of plan.subOrders) {
      const child = issues.get(id);
      if (child === undefined) continue;
      due.push({ key: parentKey(batchId, id), target: () => parentTarget(batch.issue, child) });
    }
    for (const { id, dependencies } of plan.subOrders) {
      for (const { on } of dependencies) {
        const blocked = issues.get(id);
        const blocker = issues.get(on);
        if (blocked === undefined || blocker === undefined) continue;
        due.push({ key: linkKey(batchId, id, on), target: () => linkTarget(blocked, blocker) });
      }
    }
    return { applied, issues, due };
  };

  return {
    due: (state, batchId) => {
      const keys = keysOf(state, batchId);
      if (keys === undefined) return [];
      for (const { key, target } of keys.due) targets.set(effectKey.encode(key), target());
      return keys.due.map(({ key }) => key);
    },
    target: {
      find: (key, signal) => targetOf(key).find(key, signal),
      apply: (key, signal) => targetOf(key).apply(key, signal),
    },
    recorded: (state, batchId): RecordedEvent[] => {
      const keys = keysOf(state, batchId);
      if (keys === undefined) return [];
      const { applied, issues, due } = keys;
      const { plan, stepId, attempt } = applied;
      const all =
        plan.subOrders.length + plan.subOrders.reduce((n, s) => n + 1 + s.dependencies.length, 0);
      if (due.length < all || due.some(({ key }) => !state.effects.has(effectKey.encode(key)))) {
        return [];
      }
      const number = (id: string): number => {
        const opened = issues.get(id);
        if (opened === undefined) throw new Error(`The plan of ${batchId} has no issue for ${id}`);
        return opened.number;
      };
      const event: Extract<Event, { type: 'order.decomposed' }> = {
        type: 'order.decomposed',
        batchId,
        subOrders: plan.subOrders.map(({ id, repo, touches }) => ({
          issue: number(id),
          repo,
          touches: touches.map(({ path }) => path),
          entry: id,
        })),
        dependencies: plan.subOrders.flatMap(({ id, dependencies }) =>
          dependencies.map(({ on, kind }) => ({
            subOrder: number(id),
            blockedBy: number(on),
            kind,
          })),
        ),
        plan: { stepId, attempt },
      };
      return [event];
    },
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
};
