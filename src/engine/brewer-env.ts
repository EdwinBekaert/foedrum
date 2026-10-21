// The environment of a brewer's process (#81, brewers-and-recipes §1.1): a minimal base, the
// brewer's own `env` on top, and the runner's forced variables last, so a brewer cannot undo them.

import { envNameKey } from '../platform/env.ts';

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

/** What a process needs to start on each platform, and where claude keeps its login. */
const BASE_NAMES = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMDRIVE',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'USER',
  'LOGNAME',
  'CLAUDE_CONFIG_DIR',
  // Where claude finds Git Bash on Windows when it is not where claude looks by default.
  'CLAUDE_CODE_GIT_BASH_PATH',
];

/**
 * The minimal base of `serve`'s brewers, from its own environment: what a process needs to start
 * and what claude needs to find its login, never a GitHub token (ADR 0063).
 */
export function brewerBaseEnv(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  // By key, as buildBrewerEnv merges: on Windows `Path` is `PATH`.
  const key = envNameKey(platform);
  const kept = (name: string): boolean =>
    BASE_NAMES.includes(key(name)) || /^ANTHROPIC_[A-Z0-9_]+$/.test(key(name));
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined || !kept(name) ? [] : [[name, value]],
    ),
  );
}

/**
 * The runner's forced variables (brewers-and-recipes §1.1): npm runs no lifecycle script, and git
 * holds no credential that lets a push succeed (ADR 0109).
 */
export function brewerForcedEnv(): Record<string, string> {
  throw new Error('not implemented');
}

/** The layers merged in order; a later layer replaces a name of an earlier one. */
export function buildBrewerEnv(layers: BrewerEnvLayers): Record<string, string> {
  const { base, brewer, forced, platform } = layers;
  const key = envNameKey(platform);
  // By key, so on Windows a later `PATH` replaces an earlier `Path`, spelling included.
  const merged = new Map<string, [string, string]>();
  for (const layer of [base, brewer, forced]) {
    for (const [name, value] of Object.entries(layer)) merged.set(key(name), [name, value]);
  }
  return Object.fromEntries(merged.values());
}
