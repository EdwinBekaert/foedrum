// What `foedrum serve` needs to know (ADR 0063), the pure core: from the text of the Brewery's
// files, this machine's environment and doctor's diagnosis, either everything serve sets up or one
// line per problem. serve.ts runs it; main.ts reads the files.

import { join } from 'node:path';
import { modelOf } from '../brewers/attempt-plan.ts';
import { brewerBaseEnv, type Env } from '../engine/brewer-env.ts';
import {
  type BreweryFiles,
  invalidRecipes,
  loadRecipes,
  type StepBrewers,
} from '../engine/recipe-files.ts';
import type { Recipes } from '../engine/recipes.ts';
import { BrewerFrontmatter } from '../schemas/brewer.ts';
import { BreweryConfig } from '../schemas/brewery-config.ts';
import { LocalConfig } from '../schemas/local-config.ts';
import { ModelsConfig } from '../schemas/models.ts';
import { readDoc, readJsonc } from '../schemas/read.ts';
import type { z } from '../schemas/zod.ts';
import { repoFolder } from '../workspace/attempt-worktrees.ts';
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
    /** models.jsonc */
    models: string | undefined;
    brewery: BreweryFiles;
  };
  diagnosis: Pick<Diagnosis, 'tools' | 'isolation' | 'problems'>;
}

/** A target repository the attempts write in. */
export interface ServeRepository {
  repo: string;
  source: 'local' | 'managed';
  /** The revision new attempt worktrees start at: `origin/<base>`. */
  base: string;
  /** The user's clone: the worktrees' for `local`, the objects to borrow for `managed`. */
  clone?: string;
  /** Its toolchain rules (ADR 0023). */
  tools: readonly string[];
}

export interface ServeSetup {
  /** The Brewery's owner/name, as foedrum.jsonc spells it. */
  brewery: string;
  workRoot: string;
  /** The event store: `.foedrum/index.db` in the checkout. */
  store: string;
  /** The state branch's worktree: `<workRoot>/state`. */
  stateWorktree: string;
  repositories: readonly ServeRepository[];
  models: ModelsConfig;
  recipes: Recipes;
  brewers: StepBrewers;
  github: { api: string; token: string };
  /** Where claude is, as doctor found it. */
  claude: string;
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  /** The brewers' base environment and the runner's forced variables (ADR 0028). */
  brewerEnv: { base: Env; forced: Env };
}

export type ServeSetupResult =
  | { kind: 'ready'; setup: ServeSetup }
  | { kind: 'refused'; problems: string[] };

const DEFAULT_API = 'https://api.github.com';
const DEFAULT_BASE = 'main';

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
  const models = read('models.jsonc', files.models, ModelsConfig, notFound, problems);
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (token === undefined || token === '') {
    problems.push(
      "set GH_TOKEN or GITHUB_TOKEN to a GitHub token that can read the Brewery's issues",
    );
  }

  if (config !== undefined && config.brewery === undefined) {
    problems.push('foedrum.jsonc: name the Brewery with "brewery": "<owner>/<name>" (ADR 0063)');
  }
  const repositories = Object.entries(config?.repositories ?? {}).map(
    ([repo, repository]): ServeRepository => {
      const source = repository.source ?? 'local';
      const clone = local === undefined ? undefined : local.clones[repo];
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
      };
    },
  );

  const loaded = loadRecipes(files.brewery);
  if (!loaded.valid) problems.push(invalidRecipes(loaded.problems));
  // Every brewer's alias has a model, so no attempt finds out only when it starts.
  if (models !== undefined) {
    for (const file of files.brewery.brewers) {
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
  const claude = diagnosis.tools.find(({ name }) => name === 'claude')?.path;

  if (
    problems.length > 0 ||
    config?.brewery === undefined ||
    models === undefined ||
    token === undefined ||
    !loaded.valid ||
    claude === undefined
  ) {
    return { kind: 'refused', problems };
  }
  const { brewery } = config;
  const workRoot = local?.workRoot ?? join(home, '.foedrum', repoFolder(brewery));
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
      github: { api: config.githubApi ?? DEFAULT_API, token },
      claude,
      sandbox: diagnosis.isolation.level === 'sandboxed',
      brewerEnv: {
        base: brewerBaseEnv(env, platform),
        forced: { npm_config_ignore_scripts: 'true' },
      },
    },
  };
};
