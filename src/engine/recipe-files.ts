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
import { RECIPE_CHOICE } from '../schemas/recipe-choice.ts';
import type { Attempt } from './fold.ts';
import type { Recipe, RecipeAction, Recipes, RouteWhy, Stall } from './recipes.ts';
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

/** A recipe a step that chooses the recipe may offer: its name and description (ADR 0232). */
export interface RecipeChoice {
  name: string;
  description: string;
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
  /** On a Taster's step of several lenses: each, in the step's order, reviewed together (ADR 0220). */
  together?: readonly string[];
  /** On a Taster's step: whether a `changes` verdict holds the batch up (ADR 0161). */
  blocking?: boolean;
  /** On an interactive step: the recipe's first message to the session (ADR 0222). */
  interactive?: { prompt: string };
  /**
   * On a step that chooses the recipe, or whose brewer names the recipes input: the Brewery's recipes
   * but those that choose one, in order (ADR 0232, ADR 0234).
   */
  choices?: readonly RecipeChoice[];
}

/** Every brewer and lens in use, and what names them: what doctor reports on (ADR 0141). */
export interface Catalog {
  brewers: readonly (StepBrewer & { name: string; path: string })[];
  lenses: readonly Lens[];
  /**
   * The brewers the recipes' steps name, the lenses those brewers' inputs and steps name, and of
   * those the lenses a lens step reviews through (ADR 0221).
   */
  named: {
    brewers: ReadonlySet<string>;
    lenses: ReadonlySet<string>;
    reviewLenses: ReadonlySet<string>;
  };
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
  /**
   * Where its onFail (a check), onBlocked findings (a brewer) or onPullRequestFail (the
   * openPullRequest action, ADR 0219) route goes, and how often.
   */
  route: { why: RouteWhy; goto: string; maxRounds: number } | undefined;
  /** The action it is, which the engine runs itself (ADR 0071); none for a brewer or a check. */
  action?: RecipeAction;
  /** A check step that expects its checks to pass: not a red proof (ADR 0164). */
  passes?: true;
  /** The parallel group it is a child of (ADR 0168). */
  group?: string;
  /** A brewer step whose attempts run as a person's session (ADR 0222). */
  interactive?: true;
  /** A brewer step whose answer chooses the batch's recipe (ADR 0232). */
  chooses?: true;
}

/**
 * The deadline of the openPullRequest action (ADR 0071): its effects are retried on every pass of
 * the driver until then, through a GitHub rate-limit pause, which lasts an hour at most (ADR 0052).
 */
const ACTION_DEADLINE = '2h';
/**
 * How many attempts the action gets in each round of its pull request (ADR 0219): one fails only
 * when it has nothing to push.
 */
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
      ...(step.lenses === undefined
        ? []
        : [
            `step "${id}" has "lenses", but its brewer "${brewer.name}" is no Taster: a lens step's brewer answers with the out doc schema "${TASTING}" (ADR 0161, ADR 0220)`,
          ]),
      ...(step.blocking === undefined
        ? []
        : [`step "${id}" has "blocking", which the engine does not follow yet (ADR 0053)`]),
    ];
  }
  if (step.lens === undefined && step.lenses === undefined) {
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
  concurrency: number | undefined,
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
  // A route counts the attempts of its goto step it scheduled (ADR 0064).
  const roundsOf: Recipe['rounds'] = (batch, id, why) => {
    const { route } = at(id);
    if (route === undefined || route.why !== why) return undefined;
    const attempts = batch.steps.get(route.goto)?.attempts.values() ?? [];
    return [...attempts].filter(
      (attempt) => attempt.route?.from === id && attempt.route.why === why,
    ).length;
  };
  return {
    ...(concurrency === undefined ? {} : { concurrency }),
    // A recipe has at least one step (its schema).
    firstStep: steps[0] === undefined ? '' : named(steps[0]),
    steps: steps.map(({ id }) => id),
    has: (id) => byId.has(id) || groups.has(id),
    children: (id) => children.get(id),
    group: (id) => byId.get(id)?.group,
    interactive: (id) => byId.get(id)?.interactive === true,
    choosesRecipe: (id) => byId.get(id)?.chooses === true,
    chosen: () => {
      throw new Error('not implemented');
    },
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
    loopBack: (batch, id, why) => {
      const { route } = at(id);
      const rounds = roundsOf(batch, id, why);
      if (route === undefined || rounds === undefined) return undefined;
      return rounds < route.maxRounds ? route.goto : undefined;
    },
    rounds: roundsOf,
    maxRounds: (id, why) => {
      const { route } = at(id);
      return route?.why === why ? route.maxRounds : undefined;
    },
    routesTo: (id, why) => {
      const { route } = at(id);
      return route?.why === why ? route.goto : undefined;
    },
  };
}

/** A step that loaded: its line, and the brewer or check it runs. */
interface LoadedStep {
  line: LineStep;
  brewer?: StepBrewer;
  check?: StepCheck;
}

/**
 * A step that loaded, or the problems that refuse it, without its file's path: none when what
 * refuses it is reported as a file of its own.
 */
type StepLoad = LoadedStep | string[];

/** What a brewer step loads against: the brewers and lenses read. */
interface Shelf {
  brewers: ReadonlyMap<string, StepBrewer>;
  /** The name of every brewer file, also one that did not load. */
  brewerNames: ReadonlySet<string>;
  lenses: ReadonlyMap<string, Lens>;
  /** Whether a lens that did not load is not reported as its own file or folder. */
  unreported: (lens: string) => boolean;
}

/**
 * Why a step's deadline cannot load: the Duration schema has no upper bound, and a deadline past
 * what a time can hold would throw when the step is scheduled, naming no file.
 */
function tooLong(id: string, deadline: string): string | undefined {
  return durationMs(deadline) <= MAX_DEADLINE_MS
    ? undefined
    : `step "${id}" has a deadline of ${deadline}, longer than 365 days`;
}

/** The openPullRequest action's line, when it is the recipe's `last` step (ADR 0071). */
function actionLine(step: ActionStep, last: boolean): StepLoad {
  const id = stepId(step);
  // The pull request holds the commits of the steps before it; none may come after it.
  if (!last) {
    return [
      `step "${id}" opens the pull request, so it must be the last step of the recipe (ADR 0071)`,
    ];
  }
  const line: LineStep = {
    id,
    when: step.when,
    deadline: ACTION_DEADLINE,
    // An action makes no progress the runner could see; its deadline covers it.
    stall: undefined,
    // The attempts of this round: those after the step's latest that succeeded (ADR 0219).
    mayRetry: (attempts) => {
      const succeeded = attempts.findLastIndex(
        (attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
      );
      return attempts.length - succeeded - 1 < ACTION_ATTEMPTS;
    },
    route:
      step.onPullRequestFail === undefined
        ? undefined
        : { why: 'pull_request', ...step.onPullRequestFail },
    action: 'openPullRequest',
  };
  return { line };
}

/** A check step's line and checks (ADR 0069). */
function checkLine(step: CheckStep): StepLoad {
  const id = stepId(step);
  const deadline = step.deadline ?? CHECK_DEADLINE;
  const long = tooLong(id, deadline);
  if (long !== undefined) return [long];
  const { onFail } = step;
  const line: LineStep = {
    id,
    when: step.when,
    deadline,
    stall: undefined,
    mayRetry: (attempts) => attempts.filter(readNothing).length < CHECK_RETRIES,
    route: onFail === undefined ? undefined : { why: 'failed', ...onFail },
    ...(step.expect === 'fail' ? {} : { passes: true as const }),
  };
  const checks = Array.isArray(step.check) ? step.check : [step.check];
  return { line, check: { checks, ...('of' in step ? { of: step.of } : {}) } };
}

/**
 * Why a brewer step cannot be a child of a parallel group, or `undefined` when it can: no child
 * writes the task tree beside its siblings (ADR 0168), nor holds the terminal while they run (ADR
 * 0222).
 */
function ungrouped(step: BrewerStep, brewer: BrewerFrontmatter): string | undefined {
  if (step.interactive === true) {
    return 'is interactive: a parallel group runs its children side by side, and a session needs the terminal to itself (ADR 0222)';
  }
  if (!isTaster(brewer)) {
    return `has the brewer "${brewer.name}", which is no Taster: a parallel group runs Tasters' lens steps (ADR 0168)`;
  }
  if (brewer.produces === 'commits') {
    return `has the Taster "${brewer.name}", which produces commits: no child of a parallel group writes the task tree (ADR 0168)`;
  }
  return undefined;
}

/** The step's one lens, or its lenses together (ADR 0220). */
const lensesOf = (step: BrewerStep): readonly string[] =>
  step.lenses ?? (step.lens === undefined ? [] : [step.lens]);

/** A brewer step's line and brewer, a Taster's with its lenses (ADR 0161), in `group` if any. */
function brewerLine(step: BrewerStep, group: string | undefined, shelf: Shelf): StepLoad {
  const id = stepId(step);
  const found = shelf.brewers.get(step.brewer);
  if (found === undefined) {
    return shelf.brewerNames.has(step.brewer)
      ? []
      : [
          `it names no brewer "${step.brewer}" that the Brewery's brewers/ or Foedrum's defaults have (ADR 0098)`,
        ];
  }
  const { brewer } = found;
  const refused = unplannable(brewer);
  if (refused.length > 0) {
    return refused.map(
      (what) =>
        `step "${id}" has the brewer "${brewer.name}", with ${what}, which the engine does not follow yet (ADR 0059)`,
    );
  }
  const apart = group === undefined ? undefined : ungrouped(step, brewer);
  if (apart !== undefined) return [`step "${id}" in the parallel group "${group}" ${apart}`];
  if (step.interactive === true && (step.lens ?? step.lenses) !== undefined) {
    const field = step.lens === undefined ? 'lenses' : 'lens';
    return [
      `step "${id}" is interactive and has a "${field}": a lens step is a Taster's headless review (ADR 0222)`,
    ];
  }
  // Only a person's answer to a recipe choice's question chooses the recipe (ADR 0232).
  const choosing = brewer.output.schema === RECIPE_CHOICE;
  if (choosing !== (step.chooses !== undefined)) {
    return [
      choosing
        ? `step "${id}" has the brewer "${brewer.name}", which answers with the out doc schema "${RECIPE_CHOICE}": give the step "chooses": "recipe" (ADR 0232)`
        : `step "${id}" has "chooses", but its brewer "${brewer.name}" does not answer with the out doc schema "${RECIPE_CHOICE}" (ADR 0232)`,
    ];
  }
  const refusedLens = untasted(step, brewer);
  const named = lensesOf(step);
  if (refusedLens.length === 0) {
    for (const name of named) {
      // A lens whose file or folder has a problem of its own is reported once, as that.
      if (shelf.lenses.has(name) || !shelf.unreported(name)) continue;
      refusedLens.push(
        `step "${id}" names the lens "${name}", which neither the Brewery's lenses/ nor Foedrum's defaults have (ADR 0161)`,
      );
    }
  }
  const stepLensFiles = named.flatMap((name) => shelf.lenses.get(name) ?? []);
  if (refusedLens.length > 0 || stepLensFiles.length < named.length) return refusedLens;
  const deadline = step.deadline ?? brewer.deadline;
  const long = tooLong(id, deadline);
  if (long !== undefined) return [long];
  const findings = step.onBlocked?.findings;
  const line: LineStep = {
    id,
    when: step.when,
    deadline,
    stall: brewer.stall,
    // Attempts are counted over the batch's whole life (ADR 0053).
    mayRetry: (attempts) => attempts.length < brewer.maxAttempts,
    route: findings === undefined ? undefined : { why: 'findings', ...findings },
    ...(group === undefined ? {} : { group }),
    ...(step.interactive === true ? { interactive: true } : {}),
    ...(choosing ? { chooses: true as const } : {}),
  };
  const [first] = stepLensFiles;
  if (first === undefined) {
    const { prompt } = step;
    return { line, brewer: prompt === undefined ? found : { ...found, interactive: { prompt } } };
  }
  // A Taster reads its step's lens as ADR 0098's lens input (ADR 0161), and a step's lenses
  // together as that one input, which names each (ADR 0220): no lens name holds a comma.
  const names = stepLensFiles.map(({ name }) => name);
  const from = `lens:${names.join(',')}`;
  const input = { name: LENS_INPUT, from, trusted: false } as const;
  const tasting: StepBrewer = {
    ...found,
    brewer: { ...brewer, inputs: [...brewer.inputs, input] },
    lenses: new Map([
      ...(found.lenses ?? []),
      ...stepLensFiles.map((lens): [string, Lens] => [lens.name, lens]),
    ]),
    ...(step.lenses === undefined ? { lens: first.name } : { together: names }),
    blocking: step.blocking ?? false,
  };
  return { line, brewer: tasting };
}

/** A step of a recipe's line: its place in the recipe, and the parallel group it is a child of. */
interface ListedStep {
  step: Step;
  index: number;
  group?: string;
}

/** The step `listed` as the engine runs it, when it does; `last` when it is the recipe's last. */
function loadStep({ step, group }: ListedStep, last: boolean, shelf: Shelf): StepLoad {
  if (group !== undefined && step.when !== undefined) {
    return [
      `step "${stepId(step)}" in the parallel group "${group}" has a "when", which the engine does not follow in a parallel group yet (ADR 0168)`,
    ];
  }
  const runnable = runnableStep(step);
  if (typeof runnable === 'string') return [runnable];
  if ('action' in runnable) return actionLine(runnable, last);
  if ('check' in runnable) return checkLine(runnable);
  return brewerLine(runnable, group, shelf);
}

/** Where a step's route back goes, when it has one (ADR 0064, ADR 0219). */
function routeBack(step: Step): string | undefined {
  if ('onFail' in step) return step.onFail?.goto;
  if ('onBlocked' in step) return step.onBlocked?.findings.goto;
  if ('onPullRequestFail' in step) return step.onPullRequestFail?.goto;
  return undefined;
}

/**
 * Why a step of `recipe` routes back to a parallel group (ADR 0168): no attempt runs a group, so a
 * route back to one would schedule nothing it could run.
 */
function groupRoutes(recipe: RecipeFile): string[] {
  const groupIds = new Set(recipe.steps.flatMap((step) => ('parallel' in step ? [step.id] : [])));
  return [...walk(recipe.steps, ['steps'])].flatMap(({ step }) => {
    const goto = routeBack(step);
    return goto === undefined || !groupIds.has(goto)
      ? []
      : [
          `step "${stepId(step)}" routes back to the parallel group "${goto}": route to one of the steps before it (ADR 0168)`,
        ];
  });
}

/**
 * Why a child of a parallel group of `recipe` routes back to a sibling (ADR 0168): it would run
 * that sibling alone, and once its rounds are used up the group would wait for the child with
 * nothing in flight.
 */
function siblingRoutes(recipe: RecipeFile): string[] {
  return recipe.steps.flatMap((step) => {
    if (!('parallel' in step)) return [];
    const siblings = new Set(step.parallel.map(stepId));
    return step.parallel.flatMap((child) => {
      const goto = child.onBlocked?.findings.goto;
      return goto === undefined || !siblings.has(goto)
        ? []
        : [
            `step "${stepId(child)}" in the parallel group "${step.id}" routes back to "${goto}" in its own group: route to a step before the group (ADR 0168)`,
          ];
    });
  });
}

/**
 * The steps of `recipe` in a line, a parallel group's children as steps of their own in its place
 * (ADR 0168), each group's `when`, and why a group's `when` cannot load.
 */
function listSteps(recipe: RecipeFile): {
  listed: ListedStep[];
  groups: Map<string, string | undefined>;
  problems: string[];
} {
  const groups = new Map<string, string | undefined>();
  const problems: string[] = [];
  const listed = recipe.steps.flatMap((step, index): ListedStep[] => {
    if (!('parallel' in step)) return [{ step, index }];
    const unfollowed = step.when === undefined ? undefined : unfollowedWhen(step.id, step.when);
    if (unfollowed !== undefined) problems.push(unfollowed);
    groups.set(step.id, step.when);
    return step.parallel.map((child) => ({ step: child, index, group: step.id }));
  });
  return { listed, groups, problems };
}

/**
 * Why a lens of a step in `order` is in the wrong folder (ADR 0143): a step with a lens reviews a
 * diff once a step before it commits, else a plan, and each of its lenses (ADR 0220) must say the
 * same.
 */
function misfolded(order: readonly Step[], commits: (step: Step) => boolean): string[] {
  return order.flatMap((step, at) => {
    if (!('brewer' in step)) return [];
    const named = lensesOf(step);
    const committed = order.slice(0, at).find(commits);
    const reviews = committed === undefined ? 'plan' : 'diff';
    const since =
      committed === undefined
        ? 'no step before it commits'
        : `step "${stepId(committed)}" before it commits`;
    const other = reviews === 'plan' ? 'diff' : 'plan';
    return named
      .filter((lens) => !lens.startsWith(`${reviews}/`))
      .map(
        (lens) =>
          `step "${stepId(step)}" reviews a ${reviews}, since ${since}, and names the lens "${lens}", which reviews a ${other}: name a lens of lenses/${reviews}/ (ADR 0143)`,
      );
  });
}

/** The red proofs of `order` (ADR 0078), and the step whose tests each proves. */
const proofsOf = (order: readonly Step[]): { id: string; of: string }[] =>
  order.flatMap((step) => ('of' in step ? [{ id: stepId(step), of: step.of }] : []));

/**
 * Why a red proof of `order` cannot find its tests (ADR 0078): it finds them in what its step
 * committed.
 */
function ofNothing(order: readonly Step[], commits: (step: Step) => boolean): string[] {
  return proofsOf(order)
    .filter(({ of }) => {
      const proven = order.find((step) => stepId(step) === of);
      return proven === undefined || !commits(proven);
    })
    .map(
      ({ id, of }) =>
        `step "${id}" proves the tests of step "${of}", whose brewer commits nothing (ADR 0078)`,
    );
}

/**
 * Why the commits of a step of `order` would be lost (ADR 0084): the cleanup of an ended batch
 * deletes its attempt branches, and only a pull request keeps the commits. A recipe whose action
 * is not last is refused for its place (ADR 0071).
 */
function unopened(
  recipe: RecipeFile,
  order: readonly Step[],
  commits: (step: Step) => boolean,
): string[] {
  const opens = recipe.steps.some((step) => 'action' in step && step.action === 'openPullRequest');
  return (opens ? [] : order.filter(commits)).map(
    (step) =>
      `step "${stepId(step)}" has the brewer "${stepBrewerName(step)}", which produces commits, and no step opens a pull request with them: end the recipe with { "action": "openPullRequest" } (ADR 0084)`,
  );
}

/**
 * The lenses of `files` by name, whether a lens that did not load is not reported as its own file
 * or folder, and the problems of the files.
 */
function readLenses(files: readonly BreweryFile[]): {
  lenses: Map<string, Lens>;
  unreported: (lens: string) => boolean;
  problems: string[];
} {
  const problems: string[] = [];
  // A lens has no frontmatter: its folder and file name are its name (ADR 0143), and its text is
  // all of it.
  const lenses = new Map<string, Lens>();
  // A lens whose file has a problem of its own is reported once, as that file.
  const brokenLenses = new Set<string>();
  // A lens folder that could not be read may hold any lens: no brewer is told it lacks one.
  const lensFolderUnread = files.some((file) => 'unreadable' in file && isFolder(file));
  for (const file of files) {
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
  const unreported = (name: string) => !lensFolderUnread && !brokenLenses.has(name);
  return { lenses, unreported, problems };
}

/**
 * The brewers of `files`, each with the lenses its inputs name, and the problems of the files: an
 * input from a lens `lenses` lacks, unless that lens is reported as its own file or folder.
 */
function readBrewers(
  files: readonly BreweryFile[],
  lenses: ReadonlyMap<string, Lens>,
  unreported: (lens: string) => boolean,
): { read: { path: string; value: StepBrewer & { name: string } }[]; problems: string[] } {
  const problems: string[] = [];
  const read = readAll(
    files,
    'brewer',
    (text) => {
      const doc = readDoc(text, BrewerFrontmatter);
      if (!doc.valid) return doc;
      const { frontmatter: brewer, body: instructions } = doc;
      const named = new Map<string, Lens>();
      const unknown: string[] = [];
      for (const input of brewer.inputs) {
        const lens = lensOf(input.from);
        if (lens === undefined || !unreported(lens)) continue;
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
  return { read, problems };
}

/** The recipes of `files`, or every problem they have; never some of them. */
export function loadRecipes(breweryFiles: BreweryFiles): LoadedRecipes {
  const files = filesInUse(breweryFiles);
  const { lenses, unreported, problems: lensProblems } = readLenses(files.lenses);
  const { read: brewerFiles, problems: brewerProblems } = readBrewers(
    files.brewers,
    lenses,
    unreported,
  );
  const problems = [...lensProblems, ...brewerProblems];
  const brewers = new Map(
    brewerFiles.map(({ value: { name, ...found } }): [string, StepBrewer] => [name, found]),
  );
  // A brewer whose file is there but broken is reported once, as that file.
  const brewerNames = new Set(files.brewers.map(({ path }) => nameOf(path)));
  const shelf: Shelf = { brewers, brewerNames, lenses, unreported };
  // The brewers the recipes' steps name, for doctor (ADR 0141).
  const namedBrewers = new Set<string>();
  // The lenses the recipes' lens steps name (ADR 0161).
  const stepLenses = new Set<string>();
  const recipes = new Map<string, Recipe>();
  // By recipe, then step id.
  const stepBrewers = new Map<string, ReadonlyMap<string, StepBrewer>>();
  const stepChecks = new Map<string, ReadonlyMap<string, StepCheck>>();
  const redProofs = new Map<string, { id: string; of: string }>();
  // Each loaded recipe's description, in the order read, and the steps that choose a recipe, by
  // recipe: what those steps may offer is known once every recipe loaded (ADR 0232).
  const descriptions = new Map<string, string>();
  const choosingSteps = new Map<string, readonly string[]>();
  for (const { path, value } of readAll(
    files.recipes,
    'recipe',
    (text) => readJsonc(text, RecipeFile),
    problems,
  )) {
    const routes = [...groupRoutes(value), ...siblingRoutes(value)];
    const { listed, groups, problems: unlisted } = listSteps(value);
    const loads = listed.map((entry) =>
      loadStep(entry, entry.index === value.steps.length - 1, shelf),
    );
    const refusals = loads.flatMap((load) => (Array.isArray(load) ? load : []));
    problems.push(...[...routes, ...unlisted, ...refusals].map((line) => `${path}: ${line}`));
    const steps = loads.filter((load): load is LoadedStep => !Array.isArray(load));
    for (const { brewer } of steps) {
      const reviewed = brewer?.together ?? (brewer?.lens === undefined ? [] : [brewer.lens]);
      for (const name of reviewed) stepLenses.add(name);
    }
    // resolveRecipe (ADR 0028) needs every brewer the recipe names; a missing one is reported
    // above. The red proofs are checked even when a step did not load, so every problem is named
    // at once.
    const brewerOf = (name: string) => brewers.get(name)?.brewer;
    const order = [...walk(value.steps, ['steps'])].map(({ step }) => step);
    const named = order.map((step) => stepBrewerName(step));
    for (const name of named) if (name !== undefined) namedBrewers.add(name);
    if (named.some((name) => name !== undefined && brewerOf(name) === undefined)) continue;
    const { testFirst } = resolveRecipe(value, brewerOf);
    const commits = (step: Step): boolean => {
      const name = stepBrewerName(step);
      return name !== undefined && brewerOf(name)?.produces === 'commits';
    };
    const refused = [
      ...misfolded(order, commits),
      ...ofNothing(order, commits),
      ...(testFirst ? unproven(value, commits) : []),
      ...unopened(value, order, commits),
    ];
    problems.push(...refused.map((line) => `${path}: ${line}`));
    const unloaded = steps.length < listed.length;
    if (unloaded || routes.length + unlisted.length + refused.length > 0) continue;
    const [proof] = proofsOf(order);
    if (proof !== undefined) redProofs.set(value.name, proof);
    recipes.set(
      value.name,
      lineRecipe(
        value.name,
        steps.map(({ line }) => line),
        { testFirst },
        groups,
        value.concurrency,
      ),
    );
    descriptions.set(value.name, value.description);
    const choosing = steps.flatMap(({ line }) => (line.chooses === true ? [line.id] : []));
    if (choosing.length > 0) choosingSteps.set(value.name, choosing);
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
  // Every recipe but those that choose a recipe themselves: what a step that chooses offers, and what
  // the recipes input of any other brewer names, such as a plan's for its sub-orders (ADR 0232,
  // ADR 0234).
  const choices = [...descriptions]
    .filter(([name]) => !choosingSteps.has(name))
    .map(([name, description]): RecipeChoice => ({ name, description }));
  for (const [recipe, steps] of stepBrewers) {
    const chooses = choosingSteps.get(recipe) ?? [];
    const given = [...steps].map(([id, found]): [string, StepBrewer] => {
      const names = found.brewer.inputs.some(({ from }) => from === 'recipes');
      return names || chooses.includes(id) ? [id, { ...found, choices }] : [id, found];
    });
    stepBrewers.set(recipe, new Map(given));
  }
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
        reviewLenses: stepLenses,
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
