// The plan out doc (ADR 0233): an order broken into sub-orders, one repository each, with what each
// touches, how they depend on each other, and the recipe each should run with.

import { hasCycle, Repo } from './events.ts';
import { PathSafeId } from './ids.ts';
import { outDocFrontmatter } from './out-doc.ts';
import { RelativePath } from './primitives.ts';
import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

/** The name of a plan's out doc schema (`output.schema`, ADR 0233). */
export const PLAN = 'plan';

/** The bounds `order.decomposed` has, which the plan becomes once signed off (ADR 0211). */
export const MOST_SUB_ORDERS = 100;
export const MOST_PLAN_DEPENDENCIES = 1_000;
/** The most paths one sub-order touches, and the most other cuts a plan lists. */
export const MOST_TOUCHES = 20;
export const MOST_ALTERNATIVES = 10;

/** One line of at most `max` characters, so the plan comment stays within GitHub's length. */
const lineOf = (max: number) => NonEmpty.max(max).regex(/^[^\r\n]*$/, 'Must be one line');
const line = lineOf(300);

/** A sub-order's name in its plan: dependencies and the graph name it, since no issue exists yet. */
export const PlanId = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    'Must be 1 to 40 lower-case letters, digits or "-", starting and ending with a letter or digit',
  );

/** A path a sub-order expects to change, `new` when it does not exist yet. */
export const Touch = z.strictObject({
  path: RelativePath.max(300),
  new: z.literal(true).exactOptional(),
});
export type Touch = z.infer<typeof Touch>;

/** A sub-order of the plan waits for another's code or for its release, as `Dependency` does. */
export const PlanDependency = z.strictObject({ on: PlanId, kind: z.enum(['code', 'release']) });
export type PlanDependency = z.infer<typeof PlanDependency>;

/** One sub-order of a plan (ADR 0233). */
export const PlannedSubOrder = z
  .strictObject({
    id: PlanId,
    title: lineOf(120),
    repo: Repo,
    // An estimate, with no cap: the sizing lens and the gate judge it (#587, #588).
    size: z.strictObject({ lines: z.int().positive(), mechanism: line }),
    doneWhen: line,
    touches: z.array(Touch).min(1).max(MOST_TOUCHES),
    dependencies: z.array(PlanDependency).default([]),
    recipe: PathSafeId,
    why: line,
    // Off only with a reason (#219); left out, the recipe's own holds.
    testFirst: z.literal(false).exactOptional(),
    testFirstOff: line.exactOptional(),
    ready: z.boolean(),
    refinement: line.exactOptional(),
  })
  .superRefine((subOrder, ctx) => {
    if (subOrder.testFirst === false && subOrder.testFirstOff === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'testFirst false needs the reason',
        path: ['testFirstOff'],
      });
    }
    if (!subOrder.ready && subOrder.refinement === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'ready false needs the reason it needs refining',
        path: ['refinement'],
      });
    }
  });
export type PlannedSubOrder = z.infer<typeof PlannedSubOrder>;

/** Other cuts considered, each with why not, and why this one. */
export const PlanAlternatives = z.strictObject({
  considered: z
    .array(z.strictObject({ cut: line, whyNot: line }))
    .min(1)
    .max(MOST_ALTERNATIVES),
  whyThis: line,
});
export type PlanAlternatives = z.infer<typeof PlanAlternatives>;

/**
 * A plan's out doc: the contract's, with its sub-orders and alternatives on every status, so a
 * `needs_input` plan reads without them; a `done` needs its sub-orders (ADR 0233).
 */
export const PlanOutDoc = outDocFrontmatter({
  subOrders: z.array(PlannedSubOrder).max(MOST_SUB_ORDERS).exactOptional(),
  alternatives: PlanAlternatives.exactOptional(),
}).superRefine((doc, ctx) => {
  const { subOrders = [] } = doc;
  if (doc.status === 'done' && subOrders.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'A done plan has sub-orders', path: ['subOrders'] });
    return;
  }
  const ids = new Set<string>();
  subOrders.forEach(({ id }, at) => {
    if (ids.has(id)) {
      ctx.addIssue({ code: 'custom', message: 'Must be unique', path: ['subOrders', at, 'id'] });
    }
    ids.add(id);
  });
  const waits = subOrders.flatMap(({ id, dependencies }, at) =>
    dependencies.map(({ on }, each) => ({ subOrder: id, blockedBy: on, at, each })),
  );
  if (waits.length > MOST_PLAN_DEPENDENCIES) {
    ctx.addIssue({
      code: 'custom',
      message: `Must have at most ${MOST_PLAN_DEPENDENCIES} dependencies in all`,
      path: ['subOrders'],
    });
    return;
  }
  for (const { subOrder, blockedBy, at, each } of waits) {
    const message =
      blockedBy === subOrder
        ? 'Must not be the sub-order itself'
        : ids.has(blockedBy)
          ? undefined
          : 'Must be the id of a sub-order of this plan';
    if (message === undefined) continue;
    ctx.addIssue({ code: 'custom', message, path: ['subOrders', at, 'dependencies', each, 'on'] });
  }
  if (hasCycle(waits)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Must not form a cycle: those sub-orders would wait for each other forever',
      path: ['subOrders'],
    });
  }
});
export type PlanOutDoc = z.infer<typeof PlanOutDoc>;

/** What a plan's out doc holds once it is done. */
export interface PlanReport {
  subOrders: readonly PlannedSubOrder[];
  alternatives?: PlanAlternatives;
}

/** The plan of an attempt's `output` when a `plan` brewer wrote it and was done; else undefined. */
export const planOf = (output: unknown): PlanReport | undefined => {
  const read = PlanOutDoc.safeParse(output);
  if (!read.success || read.data.status !== 'done' || read.data.subOrders === undefined) {
    return undefined;
  }
  const { subOrders, alternatives } = read.data;
  return alternatives === undefined ? { subOrders } : { subOrders, alternatives };
};
