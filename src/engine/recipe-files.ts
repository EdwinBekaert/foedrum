// The Brewery's recipe files as the engine's Recipes (ADR 0053), the core (ADR 0021): every
// recipe and brewer file is read and checked, and either all of them load or none does.
// brewery-files.ts reads the files.

import { BrewerFrontmatter } from '../schemas/brewer.ts';
import { durationMs } from '../schemas/primitives.ts';
import { readDoc, readJsonc } from '../schemas/read.ts';
import {
  Recipe as RecipeFile,
  readExpression,
  type Step,
  stepBrewerName,
  stepId,
  stepKind,
  walk,
} from '../schemas/recipe.ts';
import type { Recipe, Recipes } from './recipes.ts';
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

export type LoadedRecipes =
  | { valid: true; recipes: Recipes; brewers: StepBrewers }
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

/** The step, when the engine brews it, else why it does not yet, naming the ADR that says so. */
function brewerStep(step: Step): BrewerStep | string {
  const id = stepId(step);
  if (!('brewer' in step)) {
    return `step "${id}" is a ${stepKind(step)} step, which the engine does not brew yet (ADR 0053)`;
  }
  const when = step.when === undefined ? undefined : unfollowedWhen(id, step.when);
  if (when !== undefined) return when;
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
 * The guard every attempt has anyway: the runner requires the out doc. Not `noPush`: no allow rule
 * reaches a push (ADR 0062), but a script or hook an allowed command runs can, and nothing checks
 * the remote after the attempt yet.
 */
const ENFORCED_GUARDS: ReadonlySet<string> = new Set(['requiresOutDoc']);

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

/** A recipe of brewer steps in a line, each with its brewer, and its settings. */
function brewingRecipe(
  name: string,
  steps: readonly { id: string; step: BrewerStep; brewer: BrewerFrontmatter }[],
  settings: Settings,
): Recipe {
  const byId = new Map(steps.map((entry, index) => [entry.id, { ...entry, index }]));
  const at = (id: string) => {
    const found = byId.get(id);
    if (found === undefined) throw new Error(`Recipe ${name} has no step ${id}`);
    return found;
  };
  return {
    // A recipe has at least one step (its schema).
    firstStep: steps[0]?.id ?? '',
    has: (id) => byId.has(id),
    deadlineMs: (id) => {
      const { step, brewer } = at(id);
      return durationMs(step.deadline ?? brewer.deadline);
    },
    stall: (id) => at(id).brewer.stall,
    skip: (_batch, id) => {
      const { when } = at(id).step;
      return when === undefined || holds(when, settings) ? undefined : when;
    },
    after: (_batch, id) => {
      const next = steps[at(id).index + 1];
      // The pull requests come with the openPullRequest action, which the engine does not run yet.
      return next === undefined
        ? { kind: 'done', pullRequests: [] }
        : { kind: 'step', stepId: next.id };
    },
    mayRetry: (batch, id) => (batch.steps.get(id)?.attempts.size ?? 0) < at(id).brewer.maxAttempts,
    // A brewer step has no onFail; its onBlocked route counts the attempts it scheduled.
    loopBack: (batch, id, why) => {
      const route = at(id).step.onBlocked?.findings;
      if (why !== 'findings' || route === undefined) return undefined;
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
  for (const { path, value } of readAll(
    files.recipes,
    'recipe',
    (text) => readJsonc(text, RecipeFile),
    problems,
  )) {
    const steps = value.steps.flatMap((step) => {
      const brewing = brewerStep(step);
      if (typeof brewing === 'string') {
        problems.push(`${path}: ${brewing}`);
        return [];
      }
      const found = brewers.get(brewing.brewer);
      if (found === undefined) {
        if (!brewerFiles.has(brewing.brewer)) {
          problems.push(`${path}: it names no brewer "${brewing.brewer}" the Brewery has`);
        }
        return [];
      }
      const { brewer } = found;
      const id = stepId(step);
      const refused = unplannable(brewer);
      if (refused.length > 0) {
        for (const what of refused) {
          problems.push(
            `${path}: step "${id}" has the brewer "${brewer.name}", with ${what}, which the engine does not follow yet (ADR 0059)`,
          );
        }
        return [];
      }
      const deadline = brewing.deadline ?? brewer.deadline;
      // The Duration schema has no upper bound; a deadline past what a time can hold would throw
      // when the step is scheduled, naming no file.
      if (durationMs(deadline) > MAX_DEADLINE_MS) {
        problems.push(`${path}: step "${id}" has a deadline of ${deadline}, longer than 365 days`);
        return [];
      }
      return [{ id, step: brewing, ...found }];
    });
    // resolveRecipe (ADR 0028) needs every brewer the recipe names; a missing one is reported
    // above. The red proof is checked even when a step did not load: it is a check step, which
    // the engine does not brew yet (ADR 0064).
    const brewerOf = (name: string) => brewers.get(name)?.brewer;
    const named = [...walk(value.steps, ['steps'])].map(({ step }) => stepBrewerName(step));
    if (named.some((name) => name !== undefined && brewerOf(name) === undefined)) continue;
    const { testFirst } = resolveRecipe(value, brewerOf);
    const commits = (step: Step): boolean => {
      const name = stepBrewerName(step);
      return name !== undefined && brewerOf(name)?.produces === 'commits';
    };
    const unprovenLines = testFirst ? unproven(value, commits) : [];
    for (const line of unprovenLines) problems.push(`${path}: ${line}`);
    if (steps.length < value.steps.length || unprovenLines.length > 0) continue;
    recipes.set(value.name, brewingRecipe(value.name, steps, { testFirst }));
    stepBrewers.set(
      value.name,
      new Map(steps.map(({ id, brewer, instructions }) => [id, { brewer, instructions }])),
    );
  }
  if (problems.length > 0) return { valid: false, problems };
  return {
    valid: true,
    recipes: { find: (name) => recipes.get(name) },
    brewers: { find: (recipe, id) => stepBrewers.get(recipe)?.get(id) },
  };
}

/** The one line doctor and a refused command give for `problems`. */
export function invalidRecipes(problems: readonly string[]): string {
  return `${INVALID_RECIPES}: ${problems.join('; ')}`;
}
