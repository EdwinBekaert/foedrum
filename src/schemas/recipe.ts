// Recipes: brewers, checks and actions in order, with loops (brewers-and-recipes §3).

import { PathSafeId } from './ids.ts';
import { CheckName, CommandObject, Duration } from './primitives.ts';
import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

/** A step id: a file name on the state branch (ADR 0024); `recipe` names the recipe's settings. */
const StepId = PathSafeId.refine(
  (id) => id !== 'recipe',
  '"recipe" is reserved: expressions read the recipe settings through it',
);

// `<step>.<field>`, optionally compared with a quoted value: `tasting.verdict != 'approve'`.
const expression =
  /^([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)\.([A-Za-z][A-Za-z0-9]*)(?:\s*(==|!=)\s*'([^'\r\n]*)')?$/;

/** An expression's parts: what it reads, and the value it compares that with, if any. */
export interface ExpressionParts {
  /** The step it reads, or `recipe` for the recipe's settings. */
  step: string;
  field: string;
  compare?: { op: '==' | '!='; value: string };
}

/** The parts of an expression the schema accepted, or `undefined` for any other text. */
export function readExpression(text: string): ExpressionParts | undefined {
  const [, step, field, op, value] = expression.exec(text) ?? [];
  if (step === undefined || field === undefined) return undefined;
  if (op !== '==' && op !== '!=') return { step, field };
  return { step, field, compare: { op, value: value ?? '' } };
}

const Expression = z
  .string()
  .regex(
    expression,
    'Must be <step>.<field>, optionally followed by == or != and a value in single quotes',
  );

/** Back to an earlier step, at most `maxRounds` times; after that the batch becomes Stuck. */
const Route = z.strictObject({ goto: StepId, maxRounds: z.int().positive() });

const when = Expression.optional().describe('Run the step only when this expression is true');

const BrewerStep = z.strictObject({
  id: StepId.optional().describe('Defaults to the brewer name'),
  brewer: PathSafeId,
  when,
  lens: PathSafeId.optional().describe('Taster only: the lens file that sets the review focus'),
  blocking: z.boolean().optional().describe('Brett only: surviving mutants block the verdict'),
  // Only findings are routed: an environment or divergence blocker always makes the batch Stuck.
  onBlocked: z.strictObject({ findings: Route }).optional(),
  deadline: Duration.optional().describe("Overrides the brewer's deadline"),
});

const SessionStep = z.strictObject({
  id: StepId,
  session: z.enum(['refine', 'triage', 'review']),
  when,
  deadline: Duration,
  fallback: PathSafeId.optional().describe('A brewer that runs when the deadline passes'),
});

/** A named check, or in a Brewery's own recipe a literal command (ADR 0023). */
const CheckRef = z.union([CheckName, CommandObject]);
export type CheckRef = z.infer<typeof CheckRef>;

const checkLabel = (check: z.infer<typeof CheckRef>): string =>
  typeof check === 'string' ? check : check.run;

const CheckStep = z.strictObject({
  id: StepId,
  check: z
    .union([CheckRef, z.array(CheckRef).min(1)])
    .refine(
      (check) => !Array.isArray(check) || new Set(check.map(checkLabel)).size === check.length,
      'Each check may be listed once',
    ),
  expect: z.literal('pass').default('pass'),
  when,
  onFail: Route.optional(),
  deadline: Duration.optional(),
});

/** A red proof reads the structured test report, so it only runs the `test` check (ADR 0017). */
const RedProofStep = z.strictObject({
  id: StepId,
  check: z.literal('test'),
  expect: z.literal('fail'),
  of: StepId.describe('The step whose committed tests must fail'),
  when,
  onFail: Route.optional(),
  deadline: Duration.optional(),
});

const ParallelStep = z.strictObject({
  id: StepId,
  parallel: z.array(BrewerStep).min(1).describe('Brewers that run side by side'),
  when,
});

const LoopStep = z.strictObject({
  id: StepId,
  loop: z.strictObject({
    maxRounds: z.int().positive(),
    until: Expression,
    get steps(): z.ZodArray<typeof Step> {
      return z.array(Step).min(1);
    },
  }),
  onExhausted: z.literal('stuck').default('stuck'),
  when,
});

const GateStep = z.strictObject({ id: StepId, gate: z.literal('human'), when, deadline: Duration });

const ActionStep = z.strictObject({
  id: StepId.optional().describe('Defaults to the action name in kebab case'),
  action: z.enum(['openPullRequest', 'comment', 'label', 'blend']),
  when,
});

const FanOutStep = z.strictObject({
  id: StepId,
  fanOut: z.strictObject({
    recipe: PathSafeId.optional().describe('The recipe of every sub-order; the router picks one'),
    approval: z.boolean().default(true).describe('Brew only after /foedrum approve'),
    bottling: z.enum(['perSubOrder', 'perRepo', 'manual']).default('perSubOrder'),
  }),
  when,
});

export const Step = z
  .xor([
    BrewerStep,
    SessionStep,
    CheckStep,
    RedProofStep,
    ParallelStep,
    LoopStep,
    GateStep,
    ActionStep,
    FanOutStep,
  ])
  .meta({
    id: 'step',
    description: 'Exactly one of brewer, session, check, parallel, loop, gate, action or fanOut',
  });
export type Step = z.infer<typeof Step>;

export type StepKind =
  | 'brewer'
  | 'session'
  | 'check'
  | 'parallel'
  | 'loop'
  | 'gate'
  | 'action'
  | 'fanOut';

/** The kind of a step: the one field that says what it does. */
export function stepKind(step: Step): StepKind {
  if ('brewer' in step) return 'brewer';
  if ('session' in step) return 'session';
  if ('check' in step) return 'check';
  if ('parallel' in step) return 'parallel';
  if ('loop' in step) return 'loop';
  if ('gate' in step) return 'gate';
  if ('action' in step) return 'action';
  if ('fanOut' in step) return 'fanOut';
  const unknown: never = step;
  throw new Error(`Unknown step kind: ${JSON.stringify(unknown)}`);
}

/** The step's id; a brewer step defaults to its brewer, an action to its name in kebab case. */
export function stepId(step: Step): string {
  if (step.id !== undefined) return step.id;
  if ('brewer' in step) return step.brewer;
  if ('action' in step)
    return step.action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  throw new Error(`Step without an id: ${JSON.stringify(step)}`);
}

/** The brewer a step runs: its own, or a session step's fallback; none for other steps. */
export function stepBrewerName(step: Step): string | undefined {
  if ('brewer' in step) return step.brewer;
  if ('fallback' in step) return step.fallback;
  return undefined;
}

type Path = (string | number)[];

/** Every step with its path in the recipe, nested loop and parallel steps included. */
export function* walk(steps: readonly Step[], path: Path): Generator<{ step: Step; path: Path }> {
  for (const [index, step] of steps.entries()) {
    const at = [...path, index];
    yield { step, path: at };
    if ('loop' in step) yield* walk(step.loop.steps, [...at, 'loop', 'steps']);
    if ('parallel' in step) yield* walk(step.parallel, [...at, 'parallel']);
  }
}

/** How a step refers to another: reads its result, goes back to it, or proves its tests red. */
type Reference = { id: string; path: Path; kind: 'read' | 'route' | 'proof' };

/** The step ids a step refers to, with the path of each reference within the step. */
function references(step: Step): Reference[] {
  const found: Reference[] = [];
  const read = (text: string | undefined, path: Path): void => {
    const id = text === undefined ? undefined : expression.exec(text)?.[1];
    if (id !== undefined && id !== 'recipe') found.push({ id, path, kind: 'read' });
  };
  read(step.when, ['when']);
  if ('loop' in step) read(step.loop.until, ['loop', 'until']);
  if ('of' in step) found.push({ id: step.of, path: ['of'], kind: 'proof' });
  if ('onFail' in step && step.onFail) {
    found.push({ id: step.onFail.goto, path: ['onFail', 'goto'], kind: 'route' });
  }
  if ('onBlocked' in step && step.onBlocked) {
    const path = ['onBlocked', 'findings', 'goto'];
    found.push({ id: step.onBlocked.findings.goto, path, kind: 'route' });
  }
  return found;
}

/** Where a step is: its position in walk order and the path of the list that holds it. */
type Place = { order: number; list: Path };

const encloses = (outer: Path, inner: Path): boolean =>
  outer.length <= inner.length && outer.every((part, index) => inner[index] === part);

/** Why a reference from `from` to `to` is not allowed, or undefined when it is. */
function misplaced(kind: Reference['kind'], from: Place, to: Place): string | undefined {
  switch (kind) {
    case 'read':
      return undefined;
    case 'proof':
      return to.order < from.order ? undefined : 'A red proof reads the tests of an earlier step';
    case 'route':
      return to.order < from.order && encloses(to.list, from.list)
        ? undefined
        : 'A route goes back to an earlier step at the same level or in an enclosing loop';
    default: {
      const unknown: never = kind;
      throw new Error(`Unknown reference kind: ${String(unknown)}`);
    }
  }
}

const RecipeFields = z.strictObject({
  $schema: z.string().optional().describe('The JSON Schema of this file, for editors'),
  name: PathSafeId,
  description: NonEmpty,
  match: z.strictObject({ labels: z.array(NonEmpty).min(1) }).optional(),
  budget: z.strictObject({ minutes: z.int().positive() }).optional(),
  // No default here: ADR 0017 defaults it to true for recipes that write code, which depends on
  // the brewers the recipe uses, so the loader decides when it is absent.
  testFirst: z
    .boolean()
    .optional()
    .describe(
      'Gauger and red proof before Cellarman; default true for recipes that write code, and the router may switch it off (ADR 0017)',
    ),
  steps: z.array(Step).min(1),
});

/**
 * A recipe: step ids are unique, every goto, red proof and expression names a step, a route goes
 * back to an earlier step at the same level or in an enclosing loop, and a red proof reads an
 * earlier step's tests.
 */
export const Recipe = RecipeFields.superRefine((recipe, ctx) => {
  const steps = [...walk(recipe.steps, ['steps'])];
  const places = new Map<string, Place>();
  for (const [order, { step, path }] of steps.entries()) {
    const id = stepId(step);
    if (id === 'recipe') {
      // A brewer named recipe, without an id of its own (StepId already rejects an explicit one).
      ctx.addIssue({
        code: 'custom',
        message: '"recipe" is reserved: give this step another id',
        path: [...path, 'id'],
      });
    } else if (places.has(id)) {
      ctx.addIssue({
        code: 'custom',
        message: `Step id "${id}" is used twice`,
        path: [...path, 'id'],
      });
    } else {
      places.set(id, { order, list: path.slice(0, -1) });
    }
  }
  for (const [order, { step, path }] of steps.entries()) {
    const from = { order, list: path.slice(0, -1) };
    for (const reference of references(step)) {
      const to = places.get(reference.id);
      const problem =
        to === undefined
          ? `No step has the id "${reference.id}"`
          : misplaced(reference.kind, from, to);
      if (problem !== undefined) {
        ctx.addIssue({ code: 'custom', message: problem, path: [...path, ...reference.path] });
      }
    }
  }
});
export type Recipe = z.infer<typeof Recipe>;

/** A recipe Foedrum ships: language-independent, so its checks are names only (ADR 0023). */
export const DefaultRecipe = Recipe.superRefine((recipe, ctx) => {
  for (const { step, path } of walk(recipe.steps, ['steps'])) {
    if (!('check' in step)) continue;
    const checks = Array.isArray(step.check) ? step.check : [step.check];
    if (checks.some((check) => typeof check !== 'string')) {
      ctx.addIssue({
        code: 'custom',
        message: 'A default recipe names its checks; a literal command is for Brewery recipes',
        path: [...path, 'check'],
      });
    }
  }
});
