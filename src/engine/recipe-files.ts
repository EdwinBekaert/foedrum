// The Brewery's recipe files as the engine's Recipes (ADR 0053), the core (ADR 0021): every
// recipe and brewer file is read and checked, and either all of them load or none does.
// brewery-files.ts reads the files.

import { BrewerFrontmatter } from '../schemas/brewer.ts';
import { durationMs } from '../schemas/primitives.ts';
import { readDoc, readJsonc } from '../schemas/read.ts';
import {
  type CheckRef,
  Recipe as RecipeFile,
  readExpression,
  type Step,
  stepBrewerName,
  stepId,
  stepKind,
  walk,
} from '../schemas/recipe.ts';
import type { Attempt } from './fold.ts';
import type { Recipe, RecipeAction, Recipes, Stall } from './recipes.ts';
import { resolveRecipe } from './resolve-recipe.ts';

/** A file of the Brewery, by its path from the Brewery's root with `/`: its text, or why not. */
export type BreweryFile = { path: string } & ({ text: string } | { unreadable: string });

/** The Brewery's recipe files (`recipes/*.jsonc`) and brewer files (`brewers/*.md`). */
export interface BreweryFiles {
  recipes: readonly BreweryFile[];
  brewers: readonly BreweryFile[];
}

/** The brewer of a recipe's step, with its instructions: the brewer file's body. */
export interface StepBrewer {
  brewer: BrewerFrontmatter;
  instructions: string;
}

/** The brewers of the loaded recipes' steps. */
export interface StepBrewers {
  /** The brewer of step `stepId` of recipe `recipe`, or `undefined` when there is no such step. */
  find(recipe: string, stepId: string): StepBrewer | undefined;
}

/** The checks of the loaded recipes' check steps (ADR 0069). */
export interface StepChecks {
  /** The checks of step `stepId` of recipe `recipe`, or `undefined` when it is no check step. */
  find(recipe: string, stepId: string): readonly CheckRef[] | undefined;
  /** Whether any recipe has a check step. */
  any(): boolean;
  /** The step whose tests step `stepId` of recipe `recipe` proves red, when it is a red proof. */
  proves(recipe: string, stepId: string): string | undefined;
  /** The first red proof of recipe `recipe` and the step it proves, when it has one (ADR 0078). */
  redProof(recipe: string): { id: string; of: string } | undefined;
}

/** A check step's checks, and for a red proof the step whose tests it proves. */
interface StepCheck {
  checks: readonly CheckRef[];
  of?: string;
}

export type LoadedRecipes =
  | { valid: true; recipes: Recipes; brewers: StepBrewers; checks: StepChecks }
  /** One line per problem, each starting with the file it is about. */
  | { valid: false; problems: readonly string[] };

/** What doctor and a refused command say when the files are not valid. */
export const INVALID_RECIPES = "the Brewery's recipes are not valid";

/** The longest deadline a step may have: a year. */
const MAX_DEADLINE_MS = durationMs('365d');

/** A schema's reason in one line, as doctor prints it. */
const oneLine = (reason: string): string =>
  reason
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');

/** The name a file must hold: its file name without the extension. */
const nameOf = (path: string): string => (path.split('/').at(-1) ?? '').replace(/\.[^.]*$/, '');

/** Each file's checked content, or the problems that make the load fail. */
function readAll<T extends { name: string }>(
  files: readonly BreweryFile[],
  what: 'recipe' | 'brewer',
  read: (text: string) => { valid: true; value: T } | { valid: false; reason: string },
  problems: string[],
): { path: string; value: T }[] {
  return files.flatMap((file) => {
    if ('unreadable' in file) {
      problems.push(`${file.path}: ${file.unreadable}`);
      return [];
    }
    const result = read(file.text);
    if (!result.valid) {
      problems.push(`${file.path}: ${oneLine(result.reason)}`);
      return [];
    }
    const { name } = result.value;
    if (nameOf(file.path) !== name) {
      const folder = file.path.split('/').slice(0, -1).join('/');
      const extension = file.path.slice(file.path.lastIndexOf('.'));
      problems.push(
        `${file.path}: it holds the ${what} "${name}", which belongs in ${folder}/${name}${extension}`,
      );
      return [];
    }
    return [{ path: file.path, value: result.value }];
  });
}

type BrewerStep = Extract<Step, { brewer: string }>;
type CheckStep = Extract<Step, { check: unknown }>;
type ActionStep = Extract<Step, { action: string }>;

/** A step the engine runs, as its recipe answers about it. */
interface LineStep {
  id: string;
  when: string | undefined;
  /** A `Duration`. */
  deadline: string;
  stall: Stall | undefined;
  /** Whether it gets another attempt after `attempts`, the last of which failed retryably. */
  mayRetry: (attempts: readonly Attempt[]) => boolean;
  /** Where its onFail (a check) or onBlocked findings (a brewer) route goes, and how often. */
  route: { why: 'failed' | 'findings'; goto: string; maxRounds: number } | undefined;
  /** The action it is, which the engine runs itself (ADR 0071); none for a brewer or a check. */
  action?: RecipeAction;
}

/**
 * The deadline of the openPullRequest action (ADR 0071): its effects are retried on every pass of
 * the driver until then, through a GitHub rate-limit pause, which lasts an hour at most (ADR 0052).
 */
const ACTION_DEADLINE = '2h';
/** How many attempts the action gets: one fails only when it has nothing to push. */
const ACTION_ATTEMPTS = 3;

/** The deadline of a check step without one of its own (ADR 0069). */
const CHECK_DEADLINE = '30m';

/**
 * How often a check step is tried again after an attempt that read nothing: cancelled, lost, or
 * one whose worktree the driver could not make. A check that read the tree is not tried again: it
 * would read the same.
 */
const CHECK_RETRIES = 3;

/** Whether an attempt ended without a reading of its own: cancelled, or retryably failed. */
const readNothing = (attempt: Attempt): boolean =>
  attempt.phase === 'finished' &&
  (attempt.outcome.kind === 'cancelled' ||
    (attempt.outcome.kind === 'failed' && attempt.outcome.retryable));

/** The recipe's settings after routing, which a `when` may read (ADR 0064). */
interface Settings {
  testFirst: boolean;
}

const SETTINGS: ReadonlySet<string> = new Set<keyof Settings>(['testFirst']);

/** The parts of a `when` its schema accepted. */
function partsOf(when: string) {
  const parts = readExpression(when);
  if (parts === undefined) throw new Error(`The expression ${JSON.stringify(when)} is not valid`);
  return parts;
}

/** Why the engine cannot follow `when` yet, or `undefined` when it reads a recipe setting. */
function unfollowedWhen(id: string, when: string): string | undefined {
  const { step, field } = partsOf(when);
  // A step's result is not recorded for a when to read until tasting lands (#26).
  if (step !== 'recipe') {
    return `step "${id}" has a "when" that reads step "${step}", which the engine does not follow yet (ADR 0064)`;
  }
  if (!SETTINGS.has(field)) {
    return `step "${id}" has a "when" that reads recipe.${field}, which is not a recipe setting (ADR 0064)`;
  }
  return undefined;
}

/** Whether `when`, which reads a recipe setting, holds for `settings`. */
function holds(when: string, settings: Settings): boolean {
  const { field, compare } = partsOf(when);
  const value = settings[field as keyof Settings];
  if (compare === undefined) return value === true;
  return (String(value) === compare.value) === (compare.op === '==');
}

/**
 * The step, when the engine runs it (a brewer, a check or the openPullRequest action), else why it
 * does not yet, naming the ADR that says so.
 */
function runnableStep(step: Step): BrewerStep | CheckStep | ActionStep | string {
  const id = stepId(step);
  const opens = 'action' in step && step.action === 'openPullRequest';
  if (!('brewer' in step) && !('check' in step) && !opens) {
    return `step "${id}" is a ${stepKind(step)} step, which the engine does not brew yet (ADR 0053)`;
  }
  const when = step.when === undefined ? undefined : unfollowedWhen(id, step.when);
  if (when !== undefined) return when;
  if ('action' in step || 'check' in step) return step;
  // A Taster's lens and Brett's blocking flag would load and change nothing.
  if (step.lens !== undefined) {
    return `step "${id}" has a "lens", which the engine does not follow yet (ADR 0053)`;
  }
  if (step.blocking !== undefined) {
    return `step "${id}" has "blocking", which the engine does not follow yet (ADR 0053)`;
  }
  return step;
}

/**
 * The guards the engine follows: the out doc, which the runner requires of every attempt anyway; a
 * commit after the start for a `done` of a brewer that produces commits (ADR 0074); and
 * testsUnchanged, which the tests guard checks after the attempt (ADR 0078). Not `noPush`: no
 * allow rule reaches a push (ADR 0062), but a script or hook an allowed command runs can, and
 * nothing checks the remote after the attempt yet.
 */
const ENFORCED_GUARDS: ReadonlySet<string> = new Set([
  'requiresOutDoc',
  'requiresCommits',
  'testsUnchanged',
]);

/** What `brewer` asks for that the attempt plan does not carry yet (ADR 0059). */
function unplannable(brewer: BrewerFrontmatter): string[] {
  return [
    // Every attempt works in a worktree at the task tree (ADR 0066).
    ...(brewer.tree === 'task' ? [] : [`"tree": "${brewer.tree}"`]),
    ...(brewer.retryMode === 'resume' ? ['"retryMode": "resume"'] : []),
    ...(brewer.houseYeast ? ['"houseYeast": true'] : []),
    ...(brewer.skills.length > 0 ? ['"skills"'] : []),
    ...(brewer.mcp.length > 0 ? ['"mcp"'] : []),
    ...(brewer.context === 'repo' ? ['"context": "repo"'] : []),
    ...(brewer.toolbox === undefined ? [] : ['"toolbox"']),
    ...(brewer.doneWhen === undefined ? [] : ['"doneWhen"']),
    ...brewer.guards
      .filter((guard) => !ENFORCED_GUARDS.has(guard))
      .map((guard) => `the guard "${guard}"`),
  ];
}

/**
 * Why a test-first recipe does not prove its tests red before it writes code (ADR 0064): it needs
 * a red proof of its first step that commits, and no other step that commits before that proof.
 */
function unproven(recipe: RecipeFile, commits: (step: Step) => boolean): string[] {
  const order = [...walk(recipe.steps, ['steps'])].map(({ step }) => step);
  const first = order.find(commits);
  const proven = first === undefined ? undefined : stepId(first);
  const at = order.findIndex((step) => 'of' in step && step.of === proven);
  const proof = order[at];
  if (proven === undefined || proof === undefined) {
    return [
      'it is a test-first recipe without a red proof: add a check step with "expect": "fail" whose "of" names the step that commits the failing tests, or set testFirst: false (ADR 0064)',
    ];
  }
  return order
    .slice(0, at)
    .filter((step) => commits(step) && stepId(step) !== proven)
    .map(
      (step) =>
        `step "${stepId(step)}" commits before the red proof "${stepId(proof)}" of step "${proven}" (ADR 0064)`,
    );
}

/** A recipe of brewer and check steps in a line, and its settings. */
function lineRecipe(name: string, steps: readonly LineStep[], settings: Settings): Recipe {
  const byId = new Map(steps.map((entry, index) => [entry.id, { ...entry, index }]));
  const opens = steps.find((entry) => entry.action === 'openPullRequest')?.id;
  const at = (id: string) => {
    const found = byId.get(id);
    if (found === undefined) throw new Error(`Recipe ${name} has no step ${id}`);
    return found;
  };
  return {
    // A recipe has at least one step (its schema).
    firstStep: steps[0]?.id ?? '',
    steps: steps.map(({ id }) => id),
    has: (id) => byId.has(id),
    action: (id) => at(id).action,
    deadlineMs: (id) => durationMs(at(id).deadline),
    stall: (id) => at(id).stall,
    skip: (_batch, id) => {
      const { when } = at(id);
      return when === undefined || holds(when, settings) ? undefined : when;
    },
    after: (_batch, id) => {
      const next = steps[at(id).index + 1];
      if (next !== undefined) return { kind: 'step', stepId: next.id };
      // The batch goes on tap with the pull request of its action, which is the last step.
      return opens === undefined
        ? { kind: 'done', pullRequests: [] }
        : { kind: 'done', pullRequests: [], opens };
    },
    mayRetry: (batch, id) => at(id).mayRetry([...(batch.steps.get(id)?.attempts.values() ?? [])]),
    // A route counts the attempts of its goto step it scheduled (ADR 0064).
    loopBack: (batch, id, why) => {
      const { route } = at(id);
      if (route === undefined || route.why !== why) return undefined;
      const attempts = batch.steps.get(route.goto)?.attempts.values() ?? [];
      const rounds = [...attempts].filter(
        (attempt) => attempt.route?.from === id && attempt.route.why === why,
      ).length;
      return rounds < route.maxRounds ? route.goto : undefined;
    },
  };
}

/** The recipes of `files`, or every problem they have; never some of them. */
export function loadRecipes(files: BreweryFiles): LoadedRecipes {
  const problems: string[] = [];
  const brewers = new Map(
    readAll(
      files.brewers,
      'brewer',
      (text) => {
        const doc = readDoc(text, BrewerFrontmatter);
        if (!doc.valid) return doc;
        const { frontmatter: brewer, body: instructions } = doc;
        return { valid: true, value: { name: brewer.name, brewer, instructions } };
      },
      problems,
    ).map(({ value: { name, ...found } }): [string, StepBrewer] => [name, found]),
  );
  // A brewer whose file is there but broken is reported once, as that file.
  const brewerFiles = new Set(files.brewers.map(({ path }) => nameOf(path)));
  const recipes = new Map<string, Recipe>();
  // By recipe, then step id.
  const stepBrewers = new Map<string, ReadonlyMap<string, StepBrewer>>();
  const stepChecks = new Map<string, ReadonlyMap<string, StepCheck>>();
  const redProofs = new Map<string, { id: string; of: string }>();
  for (const { path, value } of readAll(
    files.recipes,
    'recipe',
    (text) => readJsonc(text, RecipeFile),
    problems,
  )) {
    // The Duration schema has no upper bound; a deadline past what a time can hold would throw
    // when the step is scheduled, naming no file.
    const tooLong = (id: string, deadline: string): boolean => {
      if (durationMs(deadline) <= MAX_DEADLINE_MS) return false;
      problems.push(`${path}: step "${id}" has a deadline of ${deadline}, longer than 365 days`);
      return true;
    };
    const steps = value.steps.flatMap(
      (step, index): { line: LineStep; brewer?: StepBrewer; check?: StepCheck }[] => {
        const runnable = runnableStep(step);
        if (typeof runnable === 'string') {
          problems.push(`${path}: ${runnable}`);
          return [];
        }
        const id = stepId(step);
        if ('action' in runnable) {
          // The pull request holds the commits of the steps before it; none may come after it.
          if (index < value.steps.length - 1) {
            problems.push(
              `${path}: step "${id}" opens the pull request, so it must be the last step of the recipe (ADR 0071)`,
            );
            return [];
          }
          const line: LineStep = {
            id,
            when: runnable.when,
            deadline: ACTION_DEADLINE,
            // An action makes no progress the runner could see; its deadline covers it.
            stall: undefined,
            mayRetry: (attempts) => attempts.length < ACTION_ATTEMPTS,
            route: undefined,
            action: 'openPullRequest',
          };
          return [{ line }];
        }
        if ('check' in runnable) {
          const deadline = runnable.deadline ?? CHECK_DEADLINE;
          if (tooLong(id, deadline)) return [];
          const { onFail } = runnable;
          const line: LineStep = {
            id,
            when: runnable.when,
            deadline,
            stall: undefined,
            mayRetry: (attempts) => attempts.filter(readNothing).length < CHECK_RETRIES,
            route: onFail === undefined ? undefined : { why: 'failed', ...onFail },
          };
          const checks = Array.isArray(runnable.check) ? runnable.check : [runnable.check];
          return [{ line, check: { checks, ...('of' in runnable ? { of: runnable.of } : {}) } }];
        }
        const found = brewers.get(runnable.brewer);
        if (found === undefined) {
          if (!brewerFiles.has(runnable.brewer)) {
            problems.push(`${path}: it names no brewer "${runnable.brewer}" the Brewery has`);
          }
          return [];
        }
        const { brewer } = found;
        const refused = unplannable(brewer);
        if (refused.length > 0) {
          for (const what of refused) {
            problems.push(
              `${path}: step "${id}" has the brewer "${brewer.name}", with ${what}, which the engine does not follow yet (ADR 0059)`,
            );
          }
          return [];
        }
        const deadline = runnable.deadline ?? brewer.deadline;
        if (tooLong(id, deadline)) return [];
        const findings = runnable.onBlocked?.findings;
        const line: LineStep = {
          id,
          when: runnable.when,
          deadline,
          stall: brewer.stall,
          // Attempts are counted over the batch's whole life (ADR 0053).
          mayRetry: (attempts) => attempts.length < brewer.maxAttempts,
          route: findings === undefined ? undefined : { why: 'findings', ...findings },
        };
        return [{ line, brewer: found }];
      },
    );
    // resolveRecipe (ADR 0028) needs every brewer the recipe names; a missing one is reported
    // above. The red proofs are checked even when a step did not load, so every problem is named
    // at once.
    const brewerOf = (name: string) => brewers.get(name)?.brewer;
    const named = [...walk(value.steps, ['steps'])].map(({ step }) => stepBrewerName(step));
    if (named.some((name) => name !== undefined && brewerOf(name) === undefined)) continue;
    const { testFirst } = resolveRecipe(value, brewerOf);
    const commits = (step: Step): boolean => {
      const name = stepBrewerName(step);
      return name !== undefined && brewerOf(name)?.produces === 'commits';
    };
    const order = [...walk(value.steps, ['steps'])].map(({ step }) => step);
    // A red proof finds the tests in what its step committed (ADR 0078).
    const proofs = order.flatMap((step) =>
      'of' in step ? [{ id: stepId(step), of: step.of }] : [],
    );
    const ofNothing = proofs.filter(({ of }) => {
      const proven = order.find((step) => stepId(step) === of);
      return proven === undefined || !commits(proven);
    });
    for (const { id, of } of ofNothing) {
      problems.push(
        `${path}: step "${id}" proves the tests of step "${of}", whose brewer commits nothing (ADR 0078)`,
      );
    }
    const unprovenLines = testFirst ? unproven(value, commits) : [];
    for (const line of unprovenLines) problems.push(`${path}: ${line}`);
    // The cleanup of an ended batch deletes its attempt branches: only a pull request keeps the
    // commits (ADR 0084). A recipe whose action is not last is refused for its place (ADR 0071).
    const opens = value.steps.some((step) => 'action' in step && step.action === 'openPullRequest');
    const unopened = opens ? [] : order.filter(commits);
    for (const step of unopened) {
      problems.push(
        `${path}: step "${stepId(step)}" has the brewer "${stepBrewerName(step)}", which produces commits, and no step opens a pull request with them: end the recipe with { "action": "openPullRequest" } (ADR 0084)`,
      );
    }
    const refused = ofNothing.length + unprovenLines.length + unopened.length > 0;
    if (steps.length < value.steps.length || refused) continue;
    const [proof] = proofs;
    if (proof !== undefined) redProofs.set(value.name, proof);
    recipes.set(
      value.name,
      lineRecipe(
        value.name,
        steps.map(({ line }) => line),
        { testFirst },
      ),
    );
    stepBrewers.set(
      value.name,
      new Map(
        steps.flatMap(({ line, brewer }) => (brewer === undefined ? [] : [[line.id, brewer]])),
      ),
    );
    stepChecks.set(
      value.name,
      new Map(steps.flatMap(({ line, check }) => (check === undefined ? [] : [[line.id, check]]))),
    );
  }
  if (problems.length > 0) return { valid: false, problems };
  return {
    valid: true,
    recipes: { find: (name) => recipes.get(name) },
    brewers: { find: (recipe, id) => stepBrewers.get(recipe)?.get(id) },
    checks: {
      find: (recipe, id) => stepChecks.get(recipe)?.get(id)?.checks,
      any: () => [...stepChecks.values()].some((steps) => steps.size > 0),
      proves: (recipe, id) => stepChecks.get(recipe)?.get(id)?.of,
      redProof: (recipe) => redProofs.get(recipe),
    },
  };
}

/** The one line doctor and a refused command give for `problems`. */
export function invalidRecipes(problems: readonly string[]): string {
  return `${INVALID_RECIPES}: ${problems.join('; ')}`;
}
