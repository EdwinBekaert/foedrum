// What `foedrum serve` needs to know (ADR 0063), the pure core: from the text of the Brewery's
// files, this machine's environment and doctor's diagnosis, either everything serve sets up or one
// line per problem. serve.ts runs it; main.ts reads the files.

import { join } from 'node:path';
import { modelOf } from '../brewers/attempt-plan.ts';
import { type ConfigDirs, configDirsOf } from '../brewers/attempt-settings.ts';
import type { RepositorySetup } from '../checks/check-runner.ts';
import type { RepositoryChecks } from '../checks/gravity.ts';
import { brewerBaseEnv, brewerForcedEnv, type Env } from '../engine/brewer-env.ts';
import { type IntakeRepository, intakeRepositories } from '../engine/intake.ts';
import {
  type BreweryFile,
  type BreweryFiles,
  filesInUse,
  invalidRecipes,
  loadRecipes,
  type StepBrewers,
  type StepChecks,
} from '../engine/recipe-files.ts';
import type { Recipes } from '../engine/recipes.ts';
import { checksRunUnsandboxed } from '../platform/check-sandbox.ts';
import { BrewerFrontmatter } from '../schemas/brewer.ts';
import {
  BreweryConfig,
  githubHostOf,
  type RepositorySource,
  type TestReportConfig,
} from '../schemas/brewery-config.ts';
import { LocalConfig } from '../schemas/local-config.ts';
import { ModelsConfig, ModelsFile } from '../schemas/models.ts';
import { durationMs } from '../schemas/primitives.ts';
import { readDoc, readJsonc } from '../schemas/read.ts';
import type { z } from '../schemas/zod.ts';
import { managedClonePath, repoFolder } from '../workspace/attempt-worktrees.ts';
import type { Diagnosis } from './doctor.ts';

/** What serve reads before it touches anything. */
export interface ServeInputs {
  /** The Brewery's checkout, where serve runs. */
  root: string;
  home: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** The files' text; undefined for a file that is not there. */
  files: {
    /** foedrum.jsonc */
    config: string | undefined;
    /** .foedrum/local.jsonc */
    local: string | undefined;
    /** models.jsonc, which merges over Foedrum's own (ADR 0153) */
    models: string | undefined;
    brewery: BreweryFiles;
    /** The Brewery's house-yeast rule files (`readHouseYeast`, ADR 0169). */
    houseYeast?: readonly BreweryFile[];
  };
  diagnosis: Pick<Diagnosis, 'tools' | 'isolation' | 'problems'>;
}

/** A target repository the attempts write in. */
export interface ServeRepository {
  repo: string;
  source: RepositorySource;
  /** The revision new attempt worktrees start at: `origin/<base>`. */
  base: string;
  /** The user's clone: the worktrees' for `local`, the objects to borrow for `managed`. */
  clone?: string;
  /** Its toolchain rules (ADR 0023). */
  tools: readonly string[];
  /** The command behind each of its checks, or null where it has none (ADR 0023, ADR 0069). */
  checks: RepositoryChecks;
  /** Where its test check writes the structured report red proofs read (ADR 0078). */
  testReport?: TestReportConfig;
  /** What runs before a brewer attempt and a check step's checks, with the network (ADR 0163). */
  setup?: RepositorySetup;
  /** Where its own house-yeast rules are kept (ADR 0018); default in the repository. */
  houseYeast?: 'repo' | 'brewery';
  /** The path globs a batch's pull request names when its change touches them (ADR 0201). */
  sensitivePaths?: readonly string[];
}

/** What the intake in serve's loop orders, and how often it polls (ADR 0068). */
export interface ServeIntake {
  /** The allow-listed GitHub logins: only an issue one of them opened is ordered. */
  users: readonly string[];
  /** How many batches may be Ordered or Brewing at once: `concurrency`. */
  capacity: number;
  pollEveryMs: number;
  /** The target repositories with an intake filter, in the order foedrum.jsonc names them. */
  repositories: readonly IntakeRepository[];
}

export interface ServeSetup {
  /** The Brewery's owner/name, as foedrum.jsonc spells it. */
  brewery: string;
  intake: ServeIntake;
  workRoot: string;
  /** The event store: `.foedrum/index.db` in the checkout. */
  store: string;
  /** The state branch's worktree: `<workRoot>/state`. */
  stateWorktree: string;
  repositories: readonly ServeRepository[];
  models: ModelsConfig;
  recipes: Recipes;
  brewers: StepBrewers;
  /** The Brewery's house-yeast rule files, for the brewers that ask for them (ADR 0169). */
  houseYeast?: readonly BreweryFile[];
  /** The checks of the recipes' check steps (ADR 0069). */
  checks: StepChecks;
  /** The host gh reaches GitHub on, with its own login (ADR 0073). */
  github: { hostname: string };
  /** Where claude is, as doctor found it. */
  claude: string;
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  /** Where the driver's environment moves the logins the sandbox hides (ADR 0160). */
  configDirs?: ConfigDirs;
  /** Whether check steps run without an OS sandbox: on native Windows only (ADR 0076). */
  unsandboxedChecks: boolean;
  /** The brewers' base environment and the runner's forced variables (ADR 0028). */
  brewerEnv: { base: Env; forced: Env };
  /** Whether the machine is kept awake while an attempt runs (ADR 0195). */
  keepAwake: boolean;
}

export type ServeSetupResult =
  | { kind: 'ready'; setup: ServeSetup }
  | { kind: 'refused'; problems: string[] };

const DEFAULT_API = 'https://api.github.com';
const DEFAULT_BASE = 'main';
/** One batch at a time (ADR 0068). */
const DEFAULT_CONCURRENCY = 1;
/** ADR 0052's interval. */
const DEFAULT_POLL = '60s';

/** A reason in one line, as doctor prints it. */
const oneLine = (reason: string): string =>
  reason
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');

/** `text` read against `schema`, or undefined with the problem added; also when it is missing. */
const read = <T>(
  file: string,
  text: string | undefined,
  schema: z.ZodType<T>,
  missing: string | undefined,
  problems: string[],
): T | undefined => {
  if (text === undefined) {
    if (missing !== undefined) problems.push(`${file}: ${missing}`);
    return undefined;
  }
  const result = readJsonc(text, schema);
  if (result.valid) return result.value;
  problems.push(`${file}: ${oneLine(result.reason)}`);
  return undefined;
};

/**
 * The models a brewer can resolve (ADR 0153): Foedrum's default `models` with the Brewery's over
 * them, by alias, and the `brewers` of the Brewery's file only. Every `brewers` alias must have a
 * model among the merged ones. Undefined, with the problems added, when a file does not pass.
 */
const mergedModels = (
  own: string | undefined,
  defaults: BreweryFile | undefined,
  problems: string[],
): ModelsConfig | undefined => {
  const none: ModelsConfig = { models: {}, brewers: {} };
  // A default that does not load is Foedrum's defect, named by its defaults/ path (ADR 0098).
  const readDefaults = (): ModelsConfig | undefined => {
    if (defaults === undefined) return none;
    if ('text' in defaults) {
      return read(defaults.path, defaults.text, ModelsConfig, undefined, problems);
    }
    problems.push(`${defaults.path}: ${defaults.unreadable}`);
    return undefined;
  };
  const fromDefaults = readDefaults();
  const fromBrewery =
    own === undefined ? none : read('models.jsonc', own, ModelsFile, undefined, problems);
  if (fromDefaults === undefined || fromBrewery === undefined) return undefined;
  const merged = {
    models: { ...fromDefaults.models, ...fromBrewery.models },
    brewers: fromBrewery.brewers,
  };
  const unmapped = Object.entries(merged.brewers).filter(
    ([, alias]) => !Object.hasOwn(merged.models, alias),
  );
  for (const [brewer, alias] of unmapped) {
    problems.push(`models.jsonc: brewers.${brewer}: No model has the alias "${alias}"`);
  }
  return unmapped.length === 0 ? merged : undefined;
};

/** What a command that needs the Brewery's name says when foedrum.jsonc has none. */
export const NAME_THE_BREWERY =
  'foedrum.jsonc: name the Brewery with "brewery": "<owner>/<name>" (ADR 0063)';

/** The host gh reaches GitHub on, with its own login, for `config`'s `githubApi` (ADR 0073). */
export const githubHostname = (config: BreweryConfig): string =>
  githubHostOf(config.githubApi ?? DEFAULT_API) ?? 'github.com';

/**
 * foedrum.jsonc's text read against its schema, for a command of the checkout `root`; throws with
 * one line when the file is missing or does not pass.
 */
export const readBreweryConfig = (text: string | undefined, root: string): BreweryConfig => {
  const problems: string[] = [];
  const config = read('foedrum.jsonc', text, BreweryConfig, `not found in ${root}`, problems);
  if (config === undefined) throw new Error(problems.join(' '));
  return config;
};

// GitHub names are case-insensitive: the two files may spell one differently.
const sameName = (one: string, other: string): boolean => one.toLowerCase() === other.toLowerCase();

/** The user's clone of `repo` that .foedrum/local.jsonc names. */
const userClone = (local: LocalConfig, repo: string): string | undefined =>
  Object.entries(local.clones).find(([name]) => sameName(name, repo))?.[1];

const workRootOf = (local: LocalConfig | undefined, home: string, brewery: string): string =>
  local?.workRoot ?? join(home, '.foedrum', repoFolder(brewery));

/**
 * The clone `repo`'s attempt worktrees are added to, from the text of foedrum.jsonc and
 * .foedrum/local.jsonc: the user's for `source: local`, the managed one in the work root
 * otherwise. Undefined when the files do not name it or do not read.
 */
export const attemptClone = (
  files: { config: string | undefined; local: string | undefined },
  home: string,
  repo: string,
): string | undefined => {
  const problems: string[] = [];
  const config = read('foedrum.jsonc', files.config, BreweryConfig, undefined, problems);
  const local = read('.foedrum/local.jsonc', files.local ?? '{}', LocalConfig, undefined, problems);
  if (config === undefined || local === undefined) return undefined;
  const repository = Object.entries(config.repositories).find(([name]) => sameName(name, repo));
  if (repository === undefined) return undefined;
  if ((repository[1].source ?? 'local') === 'local') return userClone(local, repo);
  if (config.brewery === undefined) return undefined;
  return managedClonePath(workRootOf(local, home, config.brewery), repo);
};

/** Everything serve sets up, or one line per problem, all of them at once. */
export const serveSetup = (inputs: ServeInputs): ServeSetupResult => {
  const { root, home, platform, env, files, diagnosis } = inputs;
  const problems: string[] = [];
  const notFound = `not found in ${root}`;
  const config = read(
    'foedrum.jsonc',
    files.config,
    BreweryConfig,
    `${notFound}; run foedrum serve in the Brewery's checkout`,
    problems,
  );
  // Without the file, every default applies.
  const local = read('.foedrum/local.jsonc', files.local ?? '{}', LocalConfig, undefined, problems);
  const models = mergedModels(files.models, files.brewery.defaults?.models, problems);

  if (config !== undefined && Object.keys(config.repositories).length === 0) {
    problems.push(
      'foedrum.jsonc: list at least one repository under "repositories" for foedrum serve',
    );
  }
  if (config !== undefined && config.brewery === undefined) {
    problems.push(NAME_THE_BREWERY);
  }
  if (config !== undefined && (config.users ?? []).length === 0) {
    problems.push(
      'foedrum.jsonc: list the GitHub users who may order work under "users" (ADR 0068)',
    );
  }
  const repositories = Object.entries(config?.repositories ?? {}).map(
    ([repo, repository]): ServeRepository => {
      const source = repository.source ?? 'local';
      const clone = local === undefined ? undefined : userClone(local, repo);
      if (source === 'local' && clone === undefined && local !== undefined) {
        problems.push(
          `.foedrum/local.jsonc: ${repo} has the source local, so name its clone in "clones" (ADR 0063)`,
        );
      }
      return {
        repo,
        source,
        base: `origin/${repository.base ?? DEFAULT_BASE}`,
        ...(clone === undefined ? {} : { clone }),
        tools: repository.tools,
        checks: repository.checks,
        ...(repository.testReport === undefined ? {} : { testReport: repository.testReport }),
        ...(repository.setup === undefined ? {} : { setup: repository.setup }),
        ...(repository.houseYeast === 'brewery' ? { houseYeast: 'brewery' as const } : {}),
        ...(repository.sensitivePaths === undefined
          ? {}
          : { sensitivePaths: repository.sensitivePaths }),
      };
    },
  );

  const loaded = loadRecipes(files.brewery);
  if (!loaded.valid) problems.push(invalidRecipes(loaded.problems));
  // Every brewer's alias has a model, so no attempt finds out only when it starts.
  if (models !== undefined) {
    for (const file of filesInUse(files.brewery).brewers) {
      if (!('text' in file)) continue;
      const brewer = readDoc(file.text, BrewerFrontmatter);
      if (!brewer.valid) continue;
      try {
        modelOf(models, brewer.frontmatter);
      } catch (error) {
        problems.push(`${file.path}: ${(error as Error).message}`);
      }
    }
  }

  for (const { required, what, fix } of diagnosis.problems) {
    if (required) problems.push(`${what}: ${fix}`);
  }
  // Elsewhere a check runs in bwrap or sandbox-exec, or not at all (ADR 0076).
  const unsandboxedChecks = checksRunUnsandboxed(platform);
  if (
    unsandboxedChecks &&
    config?.isolation?.minimum === 'sandboxed' &&
    loaded.valid &&
    loaded.checks.any()
  ) {
    const { level, why } = diagnosis.isolation;
    problems.push(
      `foedrum.jsonc requires the sandboxed isolation level, and check steps would run at ${level} (${why}) (ADR 0076)`,
    );
  }
  // A setup runs before brewer attempts as well as before check steps (ADR 0163). On native
  // Windows it has no sandbox, which the checks' line above already says when a recipe has a
  // check step; elsewhere it runs in the check sandbox, on Linux and WSL2 in a network namespace
  // of its own (ADR 0218).
  const checksRefused = unsandboxedChecks && loaded.valid && loaded.checks.any();
  if (config?.isolation?.minimum === 'sandboxed' && unsandboxedChecks && !checksRefused) {
    for (const { repo, setup } of repositories) {
      if (setup === undefined) continue;
      problems.push(
        `foedrum.jsonc requires the sandboxed isolation level, and ${repo}'s setup runs outside a sandbox on native Windows (ADR 0163)`,
      );
    }
  }
  const claude = diagnosis.tools.find(({ name }) => name === 'claude')?.path;

  if (
    problems.length > 0 ||
    config?.brewery === undefined ||
    models === undefined ||
    !loaded.valid ||
    claude === undefined
  ) {
    return { kind: 'refused', problems };
  }
  const { brewery } = config;
  const workRoot = workRootOf(local, home, brewery);
  return {
    kind: 'ready',
    setup: {
      brewery,
      workRoot,
      store: join(root, '.foedrum', 'index.db'),
      stateWorktree: join(workRoot, 'state'),
      repositories,
      models,
      recipes: loaded.recipes,
      brewers: loaded.brewers,
      ...(files.houseYeast === undefined ? {} : { houseYeast: files.houseYeast }),
      checks: loaded.checks,
      intake: {
        users: config.users ?? [],
        capacity: config.concurrency ?? DEFAULT_CONCURRENCY,
        pollEveryMs: durationMs(config.pollEvery ?? DEFAULT_POLL),
        repositories: intakeRepositories(config),
      },
      github: { hostname: githubHostname(config) },
      claude,
      sandbox: diagnosis.isolation.level === 'sandboxed',
      configDirs: configDirsOf(env),
      unsandboxedChecks,
      brewerEnv: {
        base: brewerBaseEnv(env, platform),
        forced: brewerForcedEnv(),
      },
      // This machine's word before the Brewery's (ADR 0195).
      keepAwake: local?.keepAwake ?? config.keepAwake ?? true,
    },
  };
};
