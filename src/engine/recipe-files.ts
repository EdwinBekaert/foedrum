// The Brewery's recipe files as the engine's Recipes (ADR 0053), the core (ADR 0021): every
// recipe and brewer file is read and checked, and either all of them load or none does.
// brewery-files.ts reads the files.

import { BrewerFrontmatter } from '../schemas/brewer.ts';
import { readDoc, readJsonc } from '../schemas/read.ts';
import { Recipe as RecipeFile, type Step, stepId, stepKind } from '../schemas/recipe.ts';
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

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** A `Duration` ("30m") in milliseconds. */
const durationMs = (duration: string): number =>
  Number(duration.slice(0, -1)) * UNIT_MS[duration.slice(-1) as keyof typeof UNIT_MS];

/** The longest deadline a step may have: a year. */
const MAX_DEADLINE_MS = 365 * UNIT_MS.d;

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

/** The step, when the engine brews it, else why it does not yet (ADR 0053). */
function brewerStep(step: Step): BrewerStep | string {
  const id = stepId(step);
  if (!('brewer' in step)) {
    return `step "${id}" is a ${stepKind(step)} step, which the engine does not brew yet`;
  }
  if (step.when !== undefined) {
    return `step "${id}" has a "when", which the engine does not follow yet`;
  }
  if (step.onBlocked !== undefined) {
    return `step "${id}" has an "onBlocked" route, which the engine does not follow yet`;
  }
  // A Taster's lens and Brett's blocking flag would load and change nothing.
  if (step.lens !== undefined) {
    return `step "${id}" has a "lens", which the engine does not follow yet`;
  }
  if (step.blocking !== undefined) {
    return `step "${id}" has "blocking", which the engine does not follow yet`;
  }
  return step;
}

/** A recipe of brewer steps in a line, each with its brewer. */
function brewingRecipe(
  name: string,
  steps: readonly { id: string; step: BrewerStep; brewer: BrewerFrontmatter }[],
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
    after: (_batch, id) => {
      const next = steps[at(id).index + 1];
      // The pull requests come with the openPullRequest action, which the engine does not run yet.
      return next === undefined
        ? { kind: 'done', pullRequests: [] }
        : { kind: 'step', stepId: next.id };
    },
    mayRetry: (batch, id) => (batch.steps.get(id)?.attempts.size ?? 0) < at(id).brewer.maxAttempts,
    loopBack: () => undefined,
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
        return doc.valid ? { valid: true, value: doc.frontmatter } : doc;
      },
      problems,
    ).map(({ value }) => [value.name, value]),
  );
  // A brewer whose file is there but broken is reported once, as that file.
  const brewerFiles = new Set(files.brewers.map(({ path }) => nameOf(path)));
  const recipes = new Map<string, Recipe>();
  for (const { path, value } of readAll(
    files.recipes,
    'recipe',
    (text) => readJsonc(text, RecipeFile),
    problems,
  )) {
    const steps = value.steps.flatMap((step) => {
      const brewing = brewerStep(step);
      if (typeof brewing === 'string') {
        problems.push(`${path}: ${brewing} (ADR 0053)`);
        return [];
      }
      const brewer = brewers.get(brewing.brewer);
      if (brewer === undefined) {
        if (!brewerFiles.has(brewing.brewer)) {
          problems.push(`${path}: it names no brewer "${brewing.brewer}" the Brewery has`);
        }
        return [];
      }
      const id = stepId(step);
      const deadline = brewing.deadline ?? brewer.deadline;
      // The Duration schema has no upper bound; a deadline past what a time can hold would throw
      // when the step is scheduled, naming no file.
      if (durationMs(deadline) > MAX_DEADLINE_MS) {
        problems.push(`${path}: step "${id}" has a deadline of ${deadline}, longer than 365 days`);
        return [];
      }
      return [{ id, step: brewing, brewer }];
    });
    // Every brewer is known once every step loaded, so resolveRecipe (ADR 0028) cannot throw.
    if (steps.length < value.steps.length) continue;
    if (resolveRecipe(value, (name) => brewers.get(name)).testFirst) {
      problems.push(
        `${path}: it is a test-first recipe, which the engine does not brew yet: set testFirst: false until test-first recipes land (#25) (ADR 0053)`,
      );
      continue;
    }
    recipes.set(value.name, brewingRecipe(value.name, steps));
  }
  if (problems.length > 0) return { valid: false, problems };
  return {
    valid: true,
    recipes: { find: (name) => recipes.get(name) },
    brewers: {
      find: () => {
        throw new Error('not implemented');
      },
    },
  };
}

/** The one line doctor and a refused command give for `problems`. */
export function invalidRecipes(problems: readonly string[]): string {
  return `${INVALID_RECIPES}: ${problems.join('; ')}`;
}
