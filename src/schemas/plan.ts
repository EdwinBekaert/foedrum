// The plan out doc (ADR 0233): an order broken into sub-orders, one repository each, with what each
// touches, how they depend on each other, and the recipe each should run with.

import { Dependency, hasCycle, MOST_PLAN_DEPENDENCIES, MOST_SUB_ORDERS, Repo } from './events.ts';
import { PathSafeId } from './ids.ts';
import { lineOf, outDocFrontmatter } from './out-doc.ts';
import { RelativePath } from './primitives.ts';
import { z } from './zod.ts';

/** The name of a plan's out doc schema (`output.schema`, ADR 0233). */
export const PLAN = 'plan';

/** The most paths one sub-order touches, and the most other cuts a plan lists. */
export const MOST_TOUCHES = 20;
export const MOST_ALTERNATIVES = 10;

/** The longest sub-order title, the longest of every other line of a plan, and the longest path. */
export const MAX_TITLE = 120;
export const MAX_PLAN_LINE = 300;
export const MAX_TOUCH_PATH = 300;

// One line, so the plan comment stays within GitHub's length.
const line = lineOf(MAX_PLAN_LINE);

/** A sub-order's name in its plan: dependencies and the graph name it, since no issue exists yet. */
export const PlanId = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    'Must be 1 to 40 lower-case letters, digits or "-", starting and ending with a letter or digit',
  );

/** A path a sub-order expects to change, `new` when it does not exist yet. */
export const Touch = z.strictObject({
  path: RelativePath.max(MAX_TOUCH_PATH),
  new: z.literal(true).exactOptional(),
});
export type Touch = z.infer<typeof Touch>;

/** A sub-order of the plan waits for another's code or for its release, as `Dependency` does. */
export const PlanDependency = z.strictObject({ on: PlanId, kind: Dependency.shape.kind });
export type PlanDependency = z.infer<typeof PlanDependency>;

/** One sub-order of a plan (ADR 0233). */
export const PlannedSubOrder = z
  .strictObject({
    id: PlanId,
    title: lineOf(MAX_TITLE),
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
  const named = new Set<string>();
  for (const { subOrder, blockedBy, at, each } of waits) {
    // A NUL is in no id, so no two pairs share a key.
    const pair = `${subOrder}\0${blockedBy}`;
    const message =
      blockedBy === subOrder
        ? 'Must not be the sub-order itself'
        : !ids.has(blockedBy)
          ? 'Must be the id of a sub-order of this plan'
          : named.has(pair)
            ? 'Must not be named twice'
            : undefined;
    named.add(pair);
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

/** A Markdown list item's text, its marker taken off, or undefined for any other line. */
const itemOf = (line: string): string | undefined => {
  const text = line.trimStart();
  const bullet = /^[-*+] /.exec(text) ?? /^\d{1,9}[.)] /.exec(text);
  return bullet === null ? undefined : text.slice(bullet[0].length);
};

/** `text` on one line, its blanks collapsed, as the plan's readable body is compared. */
const collapsed = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Why the body of a done plan's out doc does not read as one (ADR 0275), or undefined: it must hold
 * the plan's summary and each of its assumptions as a list item of its own line, each as the
 * frontmatter has it, blanks collapsed, so the out doc a comment links reads on GitHub.
 */
export const unreadableBody = (
  body: string,
  { summary, assumptions }: { summary: string; assumptions: readonly string[] },
): string | undefined => {
  if (!collapsed(body).includes(collapsed(summary))) {
    return 'its body does not hold its summary as written (ADR 0275)';
  }
  const items = new Set(
    body.split('\n').flatMap((line) => {
      const item = itemOf(line);
      return item === undefined ? [] : [collapsed(item)];
    }),
  );
  const missing = assumptions.findIndex((text) => !items.has(collapsed(text)));
  return missing < 0
    ? undefined
    : `its body does not hold assumptions[${missing}] as a list item, as written (ADR 0275)`;
};
