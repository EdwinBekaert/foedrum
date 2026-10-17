// What `foedrum serve` needs to know (ADR 0063), the pure core: from the text of the Brewery's
// files, this machine's environment and doctor's diagnosis, either everything serve sets up or one
// line per problem. serve.ts runs it; main.ts reads the files.

import type { Env } from '../engine/brewer-env.ts';
import type { BreweryFiles, StepBrewers } from '../engine/recipe-files.ts';
import type { Recipes } from '../engine/recipes.ts';
import type { ModelsConfig } from '../schemas/models.ts';
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

export const serveSetup = (_inputs: ServeInputs): ServeSetupResult => {
  throw new Error('not implemented');
};
