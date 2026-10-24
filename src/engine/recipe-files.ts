// The Brewery's recipe files as the engine's Recipes (ADR 0053), the core (ADR 0021): every
// recipe, brewer and lens file is read and checked, and either all of them load or none does.
// Foedrum's defaults lie under the Brewery's files: a Brewery file replaces the default of its
// name (ADR 0098), a lens the default of its folder and name (ADR 0143). brewery-files.ts reads the
// files.

import { BrewerFrontmatter } from '../schemas/brewer.ts';
import { TASTING } from '../schemas/out-doc.ts';
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

/** The files of one kind: recipes (`*.jsonc`), brewers and lenses (`*.md`). */
interface FilesByKind {
  recipes: readonly BreweryFile[];
  brewers: readonly BreweryFile[];
  lenses?: readonly BreweryFile[];
}

/**
 * The Brewery's recipe files (`recipes/*.jsonc`), brewer files (`brewers/*.md`) and lens files
 * (`lenses/diff/*.md`, `lenses/plan/*.md`, ADR 0143), and Foedrum's own defaults (ADR 0098), each
 * by its path in `defaults/`.
 */
export interface BreweryFiles extends FilesByKind {
  defaults?: Partial<FilesByKind> & {
    /** Foedrum's `defaults/models.jsonc`, merged under the Brewery's models.jsonc (ADR 0153). */
    models?: BreweryFile;
  };
}

/** A lens's text, from the Brewery's `lenses/` or Foedrum's defaults (ADR 0098). */
export interface Lens {
  /** Its folder and file name: `diff/<name>` or `plan/<name>` (ADR 0143). */
  name: string;
  /** The file it was read from: `lenses/<folder>/<name>.md` or `defaults/lenses/<folder>/<name>.md`. */
  path: string;
  text: string;
}

/** The brewer of a recipe's step, with its instructions: the brewer file's body. */
export interface StepBrewer {
  brewer: BrewerFrontmatter;
  instructions: string;
  /** The lenses its inputs name, by name. */
  lenses?: ReadonlyMap<string, Lens>;
  /** On a Taster's step: the lens it reviews through, `diff/<name>` or `plan/<name>` (ADR 0161). */
  lens?: string;
  /** On a Taster's step: whether a `changes` verdict holds the batch up (ADR 0161). */
  blocking?: boolean;
}

/** Every brewer and lens in use, and what names them: what doctor reports on (ADR 0141). */
export interface Catalog {
  brewers: readonly (StepBrewer & { name: string; path: string })[];
  lenses: readonly Lens[];
  /** The brewers the recipes' steps name, and the lenses those brewers' inputs and steps name. */
  named: { brewers: ReadonlySet<string>; lenses: ReadonlySet<string> };
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
  | {
      valid: true;
      recipes: Recipes;
      brewers: StepBrewers;
      checks: StepChecks;
      /** The paths of the default files in use: those the Brewery has no file of its name for. */
      defaults: readonly string[];
      catalog: Catalog;
    }
  /** One line per problem, each starting with the file it is about. */
  | { valid: false; problems: readonly string[] };

/** What doctor and a refused command say when the files are not valid. */
export const INVALID_RECIPES = "the Brewery's recipes are not valid";

/**
 * The most text one input of a brewer may hold: it reaches the prompt on stdin, and the event log
 * through the out doc. A lens is held to it when the brewer loads (ADR 0098).
 */
export const MAX_INPUT_BYTES = 1024 * 1024;

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

/**
 * What a file replaces a default by: its path in its kind's folder, without the extension, so
 * `nip` for `recipes/nip.jsonc` and `diff/security` for `lenses/diff/security.md` (ADR 0143).
 */
const keyOf = (path: string): string =>
  path
    .replace(/^defaults\//, '')
    .split('/')
    .slice(1)
    .join('/')
    .replace(/\.[^./]*$/, '');

/**
 * Whether `file` is a folder the shell could not list: its path names the folder, without a file
 * name and its extension, so it is never matched by name like a file.
 */
const isFolder = ({ path }: BreweryFile): boolean => !/\.[^/]*$/.test(path);

/**
 * The defaults of one kind that no file of `own` is named like: a Brewery file replaces them. A
 * defaults folder that could not be read is always kept, so it fails the load.
 */
function keptDefaults(
  own: readonly BreweryFile[],
  defaults: readonly BreweryFile[] = [],
): readonly BreweryFile[] {
  const names = new Set(own.filter((file) => !isFolder(file)).map(({ path }) => keyOf(path)));
  return defaults.filter((file) => isFolder(file) || !names.has(keyOf(file.path)));
}

/** The defaults the Brewery keeps, by kind: those it has no file of the same name for (ADR 0098). */
function defaultsKept(files: BreweryFiles): Required<FilesByKind> {
  const { defaults = {} } = files;
  return {
    recipes: keptDefaults(files.recipes, defaults.recipes),
    brewers: keptDefaults(files.brewers, defaults.brewers),
    lenses: keptDefaults(files.lenses ?? [], defaults.lenses),
  };
}

/** The files the load reads, by kind: the Brewery's own, then the defaults it keeps (ADR 0098). */
export function filesInUse(files: BreweryFiles): Required<FilesByKind> {
  const kept = defaultsKept(files);
  return {
    recipes: [...files.recipes, ...kept.recipes],
    brewers: [...files.brewers, ...kept.brewers],
    lenses: [...(files.lenses ?? []), ...kept.lenses],
  };
}

/**
 * Each Brewery file that replaces a default of the same name, with that default, recipes, then
 * brewers, then lenses (ADR 0098, ADR 0141).
 */
export function replacedDefaults(
  files: BreweryFiles,
): { own: BreweryFile; replaced: BreweryFile }[] {
  const { defaults = {} } = files;
  const pairs = (own: readonly BreweryFile[], replaceable: readonly BreweryFile[] = []) =>
    own.flatMap((file) => {
      const replaced = isFolder(file)
        ? undefined
        : replaceable.find((found) => !isFolder(found) && keyOf(found.path) === keyOf(file.path));
      return replaced === undefined ? [] : [{ own: file, replaced }];
    });
  return [
    ...pairs(files.recipes, defaults.recipes),
    ...pairs(files.brewers, defaults.brewers),
    ...pairs(files.lenses ?? [], defaults.lenses),
  ];
}

/**
 * The paths of the defaults the Brewery has no file of the same name for (ADR 0098), then Foedrum's
 * models.jsonc, which always applies under the Brewery's and is listed, not loaded (ADR 0153).
 */
function defaultsInUse(files: BreweryFiles): string[] {
  const { recipes, brewers, lenses } = defaultsKept(files);
  const { models } = files.defaults ?? {};
  return [...recipes, ...brewers, ...lenses, ...(models === undefined ? [] : [models])].map(
    ({ path }) => path,
  );
}

/** The lens a brewer input reads (`"from": "lens:<folder>/<name>"`), when it reads one. */
const lensOf = (from: string): string | undefined =>
  from.startsWith('lens:') ? from.slice('lens:'.length) : undefined;

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
  /** A check step that expects its checks to pass: not a red proof (ADR 0164). */
  passes?: true;
  /** The parallel group it is a child of (ADR 0168). */
  group?: string;
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
  return step;
}

/** Whether `brewer` is a Taster: it answers with findings and a verdict (ADR 0161). */
const isTaster = (brewer: BrewerFrontmatter): boolean => brewer.output.schema === TASTING;

/**
 * Why the lens and blocking flag of `step` cannot load with `brewer` (ADR 0161): a lens only on a
 * Taster's step, which needs one, and blocking only there, since Brett's would change nothing yet.
 */
function untasted(step: BrewerStep, brewer: BrewerFrontmatter): string[] {
  const id = stepId(step);
  if (!isTaster(brewer)) {
    return [
      ...(step.lens === undefined
        ? []
        : [
            `step "${id}" has a "lens", but its brewer "${brewer.name}" is no Taster: a lens step's brewer answers with the out doc schema "${TASTING}" (ADR 0161)`,
          ]),
      ...(step.blocking === undefined
        ? []
        : [`step "${id}" has "blocking", which the engine does not follow yet (ADR 0053)`]),
    ];
  }
  if (step.lens === undefined) {
    return [
      `step "${id}" has the Taster "${brewer.name}" and no "lens": name the lens it reviews through (ADR 0161)`,
    ];
  }
  if (brewer.inputs.some(({ name }) => name === LENS_INPUT)) {
    return [
      `step "${id}" gives the Taster "${brewer.name}" its lens as the input "${LENS_INPUT}", which the brewer has already (ADR 0161)`,
    ];
  }
  return [];
}

/** The input a lens step's Taster reads its lens from (ADR 0161). */
const LENS_INPUT = 'lens';

/**
 * The guards the engine follows: the out doc, which the runner requires of every attempt anyway; a
 * commit after the start for a `done` of a brewer that produces commits (ADR 0074); and
 * testsUnchanged, which the tests guard checks after the attempt (ADR 0078).
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

/**
 * A recipe of brewer and check steps in a line, a parallel group's children in its place, and its
 * settings; `groups` holds each group's `when`, if it has one (ADR 0168).
 */
function lineRecipe(
  name: string,
  steps: readonly LineStep[],
  settings: Settings,
  groups: ReadonlyMap<string, string | undefined>,
): Recipe {
  const byId = new Map(steps.map((entry, index) => [entry.id, { ...entry, index }]));
  const children = new Map(
    [...groups.keys()].map((group) => [
      group,
      steps.filter((entry) => entry.group === group).map(({ id }) => id),
    ]),
  );
  // A group stands where its children are: the batch enters and leaves it as one step.
  const named = (entry: LineStep): string => entry.group ?? entry.id;
  const indexOf = (id: string): number =>
    groups.has(id) ? steps.findLastIndex((entry) => entry.group === id) : at(id).index;
  const opens = steps.find((entry) => entry.action === 'openPullRequest')?.id;
  // The last checks before the pull request read the code it will hold (ADR 0164): of those the
  // recipe runs, since a `when` reads only the recipe's settings (ADR 0064).
  const runs = ({ when }: LineStep) => when === undefined || holds(when, settings);
  const merges =
    opens === undefined
      ? undefined
      : steps.findLast((entry) => entry.passes === true && runs(entry))?.id;
  const at = (id: string) => {
    const found = byId.get(id);
    if (found === undefined) throw new Error(`Recipe ${name} has no step ${id}`);
    return found;
  };
  return {
    // A recipe has at least one step (its schema).
    firstStep: steps[0] === undefined ? '' : named(steps[0]),
    steps: steps.map(({ id }) => id),
    has: (id) => byId.has(id) || groups.has(id),
    children: (id) => children.get(id),
    group: (id) => byId.get(id)?.group,
    action: (id) => at(id).action,
    mergesBase: (id) => id === merges,
    deadlineMs: (id) => durationMs(at(id).deadline),
    stall: (id) => at(id).stall,
    skip: (_batch, id) => {
      const when = groups.has(id) ? groups.get(id) : at(id).when;
      return when === undefined || holds(when, settings) ? undefined : when;
    },
    after: (_batch, id) => {
      const next = steps[indexOf(id) + 1];
      if (next !== undefined) return { kind: 'step', stepId: named(next) };
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
export function loadRecipes(breweryFiles: BreweryFiles): LoadedRecipes {
  const problems: string[] = [];
  const files = filesInUse(breweryFiles);
  // A lens has no frontmatter: its folder and file name are its name (ADR 0143), and its text is
  // all of it.
  const lenses = new Map<string, Lens>();
  // A lens whose file has a problem of its own is reported once, as that file.
  const brokenLenses = new Set<string>();
  // A lens folder that could not be read may hold any lens: no brewer is told it lacks one.
  const lensFolderUnread = files.lenses.some((file) => 'unreadable' in file && isFolder(file));
  for (const file of files.lenses) {
    const name = keyOf(file.path);
    if (!isFolder(file) && !name.includes('/')) {
      // A lens directly in lenses/: its folder says what it reviews, and it has none (ADR 0143).
      const folder = file.path.slice(0, file.path.lastIndexOf('/'));
      problems.push(
        `${file.path}: a lens belongs in ${folder}/diff/, to review a diff, or ${folder}/plan/, to review a plan (ADR 0143)`,
      );
    } else if ('unreadable' in file) {
      problems.push(`${file.path}: ${file.unreadable}`);
      brokenLenses.add(name);
    } else if (Buffer.byteLength(file.text, 'utf8') > MAX_INPUT_BYTES) {
      problems.push(
        `${file.path}: it is larger than ${MAX_INPUT_BYTES} bytes, the limit of a brewer's input (ADR 0098)`,
      );
      brokenLenses.add(name);
    } else {
      lenses.set(name, { name, path: file.path, text: file.text });
    }
  }
  const brewerFiles = readAll(
    files.brewers,
    'brewer',
    (text) => {
      const doc = readDoc(text, BrewerFrontmatter);
      if (!doc.valid) return doc;
      const { frontmatter: brewer, body: instructions } = doc;
      const named = new Map<string, Lens>();
      const unknown: string[] = [];
      for (const input of brewer.inputs) {
        const lens = lensOf(input.from);
        if (lens === undefined || lensFolderUnread || brokenLenses.has(lens)) continue;
        const found = lenses.get(lens);
        if (found !== undefined) named.set(lens, found);
        else {
          unknown.push(
            `the brewer "${brewer.name}" has the input "${input.name}" from the lens "${lens}", which neither the Brewery's lenses/ nor Foedrum's defaults have (ADR 0098)`,
          );
        }
      }
      if (unknown.length > 0) return { valid: false, reason: unknown.join('; ') };
      return {
        valid: true,
        value: { name: brewer.name, brewer, instructions, lenses: named },
      };
    },
    problems,
  );
  const brewers = new Map(
    brewerFiles.map(({ value: { name, ...found } }): [string, StepBrewer] => [name, found]),
  );
  // A brewer whose file is there but broken is reported once, as that file.
  const brewerNames = new Set(files.brewers.map(({ path }) => nameOf(path)));
  // The brewers the recipes' steps name, for doctor (ADR 0141).
  const namedBrewers = new Set<string>();
  // The lenses the recipes' lens steps name (ADR 0161).
  const stepLenses = new Set<string>();
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
    // A parallel group's children load as steps of their own, in its place (ADR 0168).
    const groups = new Map<string, string | undefined>();
    let unfollowedGroup = false;
    const listed = value.steps.flatMap(
      (step, index): { step: Step; index: number; group?: string }[] => {
        if (!('parallel' in step)) return [{ step, index }];
        const unfollowed = step.when === undefined ? undefined : unfollowedWhen(step.id, step.when);
        if (unfollowed !== undefined) {
          problems.push(`${path}: ${unfollowed}`);
          unfollowedGroup = true;
        }
        groups.set(step.id, step.when);
        return step.parallel.map((child) => ({ step: child, index, group: step.id }));
      },
    );
    const steps = listed.flatMap(
      ({ step, index, group }): { line: LineStep; brewer?: StepBrewer; check?: StepCheck }[] => {
        if (group !== undefined && step.when !== undefined) {
          problems.push(
            `${path}: step "${stepId(step)}" in the parallel group "${group}" has a "when", which the engine does not follow in a parallel group yet (ADR 0168)`,
          );
          return [];
        }
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
            ...(runnable.expect === 'fail' ? {} : { passes: true as const }),
          };
          const checks = Array.isArray(runnable.check) ? runnable.check : [runnable.check];
          return [{ line, check: { checks, ...('of' in runnable ? { of: runnable.of } : {}) } }];
        }
        const found = brewers.get(runnable.brewer);
        if (found === undefined) {
          if (!brewerNames.has(runnable.brewer)) {
            problems.push(
              `${path}: it names no brewer "${runnable.brewer}" that the Brewery's brewers/ or Foedrum's defaults have (ADR 0098)`,
            );
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
        // No child writes the task tree beside its siblings (ADR 0168).
        const ungrouped =
          group === undefined
            ? undefined
            : !isTaster(brewer)
              ? `has the brewer "${brewer.name}", which is no Taster: a parallel group runs Tasters' lens steps (ADR 0168)`
              : brewer.produces === 'commits'
                ? `has the Taster "${brewer.name}", which produces commits: no child of a parallel group writes the task tree (ADR 0168)`
                : undefined;
        if (ungrouped !== undefined) {
          problems.push(`${path}: step "${id}" in the parallel group "${group}" ${ungrouped}`);
          return [];
        }
        const refusedLens = untasted(runnable, brewer);
        const lens = runnable.lens === undefined ? undefined : lenses.get(runnable.lens);
        // A lens whose file or folder has a problem of its own is reported once, as that.
        const unreported =
          runnable.lens !== undefined && !lensFolderUnread && !brokenLenses.has(runnable.lens);
        if (refusedLens.length === 0 && lens === undefined && unreported) {
          refusedLens.push(
            `step "${id}" names the lens "${runnable.lens}", which neither the Brewery's lenses/ nor Foedrum's defaults have (ADR 0161)`,
          );
        }
        for (const line of refusedLens) problems.push(`${path}: ${line}`);
        if (refusedLens.length > 0 || (runnable.lens !== undefined && lens === undefined)) {
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
          ...(group === undefined ? {} : { group }),
        };
        if (lens === undefined) return [{ line, brewer: found }];
        // A Taster reads its step's lens as ADR 0098's lens input (ADR 0161).
        stepLenses.add(lens.name);
        const input = { name: LENS_INPUT, from: `lens:${lens.name}`, trusted: false } as const;
        const tasting: StepBrewer = {
          ...found,
          brewer: { ...brewer, inputs: [...brewer.inputs, input] },
          lenses: new Map([...(found.lenses ?? []), [lens.name, lens]]),
          lens: lens.name,
          blocking: runnable.blocking ?? false,
        };
        return [{ line, brewer: tasting }];
      },
    );
    // resolveRecipe (ADR 0028) needs every brewer the recipe names; a missing one is reported
    // above. The red proofs are checked even when a step did not load, so every problem is named
    // at once.
    const brewerOf = (name: string) => brewers.get(name)?.brewer;
    const named = [...walk(value.steps, ['steps'])].map(({ step }) => stepBrewerName(step));
    for (const name of named) if (name !== undefined) namedBrewers.add(name);
    if (named.some((name) => name !== undefined && brewerOf(name) === undefined)) continue;
    const { testFirst } = resolveRecipe(value, brewerOf);
    const commits = (step: Step): boolean => {
      const name = stepBrewerName(step);
      return name !== undefined && brewerOf(name)?.produces === 'commits';
    };
    const order = [...walk(value.steps, ['steps'])].map(({ step }) => step);
    // A step with a lens reviews a diff once a step before it commits, else a plan; its lens's
    // folder must say the same (ADR 0143).
    const misfolded = order.flatMap((step, at) => {
      if (!('lens' in step) || step.lens === undefined) return [];
      const committed = order.slice(0, at).find(commits);
      const reviews = committed === undefined ? 'plan' : 'diff';
      if (step.lens.startsWith(`${reviews}/`)) return [];
      const since =
        committed === undefined
          ? 'no step before it commits'
          : `step "${stepId(committed)}" before it commits`;
      const other = reviews === 'plan' ? 'diff' : 'plan';
      return [
        `${path}: step "${stepId(step)}" reviews a ${reviews}, since ${since}, and names the lens "${step.lens}", which reviews a ${other}: name a lens of lenses/${reviews}/ (ADR 0143)`,
      ];
    });
    for (const line of misfolded) problems.push(line);
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
    const refused =
      misfolded.length + ofNothing.length + unprovenLines.length + unopened.length > 0;
    if (steps.length < listed.length || unfollowedGroup || refused) continue;
    const [proof] = proofs;
    if (proof !== undefined) redProofs.set(value.name, proof);
    recipes.set(
      value.name,
      lineRecipe(
        value.name,
        steps.map(({ line }) => line),
        { testFirst },
        groups,
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
    defaults: defaultsInUse(breweryFiles),
    catalog: {
      brewers: brewerFiles.map(({ path, value }) => ({ ...value, path })),
      lenses: [...lenses.values()],
      named: {
        brewers: namedBrewers,
        lenses: new Set([
          ...[...brewers]
            .filter(([name]) => namedBrewers.has(name))
            .flatMap(([, { lenses: named }]) => [...(named?.keys() ?? [])]),
          ...stepLenses,
        ]),
      },
    },
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
