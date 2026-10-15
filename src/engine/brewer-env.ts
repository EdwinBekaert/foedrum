// The environment of a brewer's process (#81, brewers-and-recipes §1.1): a minimal base, the
// brewer's own `env` on top, and the runner's forced variables last, so a brewer cannot undo them.

export type Env = Readonly<Record<string, string>>;

export interface BrewerEnvLayers {
  /** The minimal base, never the engine's own `process.env`. */
  base: Env;
  /** The brewer's frontmatter `env`. */
  brewer: Env;
  /** The runner's variables (`PATH`, `npm_config_ignore_scripts`, the per-attempt settings). */
  forced: Env;
  /** Windows does not tell names apart by case; the other platforms do. */
  platform: NodeJS.Platform;
}

/** The layers merged in order; a later layer replaces a name of an earlier one. */
export function buildBrewerEnv(_layers: BrewerEnvLayers): Record<string, string> {
  throw new Error('not implemented');
}
