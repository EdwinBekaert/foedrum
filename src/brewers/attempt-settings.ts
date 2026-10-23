// Writing an attempt's `claude --settings` file (ADR 0046): always from an AttemptSettings that
// passed its schema, so the file is never one claude would drop.

import { writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import {
  AttemptSettings,
  alwaysDenied,
  sandboxCredentials,
  scopedRule,
} from '../schemas/attempt-settings.ts';
import { z } from '../schemas/zod.ts';

export interface AttemptPermissions {
  /** The brewer's tools.allow with the repository's toolchain commands (ADR 0023). */
  allow: readonly string[];
  /** The brewer's tools.deny. */
  deny: readonly string[];
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  /** Where the driver's environment moves the logins the sandbox hides (ADR 0160). */
  configDirs?: ConfigDirs;
  /** The driver's home and PATH, whose toolchain folders sandboxed commands may read (ADR 0162). */
  toolchain?: Toolchain;
}

type Variables = Readonly<Record<string, string | undefined>>;

/** The variables of `env` among `names` that are set. */
const setOf = <Name extends string>(names: readonly Name[], env: Variables) =>
  Object.fromEntries(
    names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  ) as Partial<Record<Name, string>>;

const TOOLCHAIN = ['HOME', 'PATH'] as const;

/** The variables of the driver's environment the toolchain's folders are found from (ADR 0162). */
export type Toolchain = Partial<Record<(typeof TOOLCHAIN)[number], string>>;

/** The variables of `env` the toolchain's folders are found from. */
export const toolchainOf = (env: Variables): Toolchain => setOf(TOOLCHAIN, env);

const CONFIG_DIRS = ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'] as const;

/** The variables that move a login out of the paths `sandboxCredentials` names (ADR 0160). */
export type ConfigDirs = Partial<Record<(typeof CONFIG_DIRS)[number], string>>;

/** The variables of `env` that move a login. */
export const configDirsOf = (env: Variables): ConfigDirs => setOf(CONFIG_DIRS, env);

/**
 * The logins the variables move, on the sandboxed level's POSIX paths: gh's directory (gh's
 * `GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh`), git's credential store under `$XDG_CONFIG_HOME`,
 * and Claude Code's `.credentials.json` under `CLAUDE_CONFIG_DIR`. A relative or empty value names
 * no one place and adds nothing.
 */
const movedLogins = ({
  GH_CONFIG_DIR,
  XDG_CONFIG_HOME,
  CLAUDE_CONFIG_DIR,
}: ConfigDirs): string[] => {
  const under = (dir: string | undefined, ...parts: string[]): string[] =>
    dir !== undefined && posix.isAbsolute(dir) ? [posix.join(dir, ...parts)] : [];
  return [
    ...under(GH_CONFIG_DIR),
    ...under(XDG_CONFIG_HOME, 'gh'),
    ...under(XDG_CONFIG_HOME, 'git', 'credentials'),
    ...under(CLAUDE_CONFIG_DIR, '.credentials.json'),
  ];
};

/** ADR 0087's credentials, with the logins the variables move, each path once. */
const credentialsOf = (configDirs: ConfigDirs) => {
  const moved = [...new Set(movedLogins(configDirs))];
  return {
    ...sandboxCredentials,
    files: [...sandboxCredentials.files, ...moved.map((path) => ({ path, mode: 'deny' as const }))],
  };
};

/** Homebrew's prefix on Linux: under `/home`, a user root the block denies, whoever's home it is. */
const LINUXBREW = '/home/linuxbrew/.linuxbrew';

/**
 * The layouts whose PATH folder under the home links into an install prefix around it: the folder,
 * `*` for any one name, and how many of its names the prefix keeps (ADR 0162).
 */
const LAYOUTS: readonly (readonly [string, number])[] = [
  // nvm: node, npm and npx, which link into the version's lib/node_modules, and global packages.
  ['.nvm/versions/node/*/bin', 4],
  // Volta: its shims, and the tools they run from ~/.volta/tools.
  ['.volta/bin', 1],
  // asdf: its shims, asdf itself, and the versions under ~/.asdf/installs the shims run.
  ['.asdf/shims', 1],
  ['.asdf/bin', 1],
];

/** How many names of a folder under the home the folder to re-open keeps: all but a layout's. */
const keptOf = (names: readonly string[]): number => {
  const layout = LAYOUTS.find(([folder]) => {
    const pattern = folder.split('/');
    return (
      pattern.length === names.length &&
      pattern.every((name, at) => name === '*' || name === names[at])
    );
  });
  return layout?.[1] ?? names.length;
};

/** `path` as one absolute folder: normalized, no trailing slash; '' for the root or a relative one. */
const folderOf = (path: string): string =>
  posix.isAbsolute(path) ? posix.normalize(path).replace(/\/+$/, '') : '';

/** Whether `path` is `dir` or lies inside it, in any case: macOS's default file system ignores it. */
const within = (path: string, dir: string): boolean => {
  const [inner, outer] = [path.toLowerCase(), dir.toLowerCase()];
  return inner === outer || inner.startsWith(`${outer}/`);
};

/**
 * The folders of the driver's toolchain that sandboxed commands may read under the block (ADR 0162):
 * Homebrew's prefix on Linux, and each PATH folder under the home, as a layout's prefix or as it is,
 * never its parent. Not a folder with a glob character, which a sandbox path reads as a wildcard,
 * nor one at, inside or around a hidden login, since the narrower read rule wins.
 */
const toolchainReads = (
  { HOME = '', PATH = '' }: Toolchain,
  logins: readonly string[],
): string[] => {
  const home = folderOf(HOME);
  // In the PATH folders' form, so a moved login's trailing slash still matches.
  const hidden = logins.flatMap((path) => {
    if (!path.startsWith('~/')) return [folderOf(path)];
    return home === '' ? [] : [folderOf(posix.join(home, path.slice(2)))];
  });
  const reads = PATH.split(':').flatMap((entry) => {
    const folder = folderOf(entry);
    if (folder === `${LINUXBREW}/bin` || folder === `${LINUXBREW}/sbin`) return [LINUXBREW];
    if (home === '' || !folder.startsWith(`${home}/`)) return [];
    const names = folder.slice(home.length + 1).split('/');
    return [posix.join(home, ...names.slice(0, keptOf(names)))];
  });
  return [...new Set(reads)].filter(
    (folder) =>
      !/[*?[]/.test(folder) &&
      !hidden.some((login) => within(folder, login) || within(login, folder)),
  );
};

/**
 * npm's configuration files anywhere in a re-opened folder: a prefix's global `etc/npmrc` and the
 * npm package's builtin `npmrc` can hold the login ADR 0087 hides as `~/.npmrc` (review of #437).
 * A deny holds inside a wider allow, a wildcard one too.
 */
const npmConfigsIn = (folder: string): string[] => [`${folder}/**/npmrc`, `${folder}/**/.npmrc`];

/** The settings as the schema reads them; throws with every problem when it does not. */
const valid = (settings: unknown): AttemptSettings => {
  const result = AttemptSettings.safeParse(settings);
  if (result.success) return result.data;
  throw new Error(`The attempt settings are not valid:\n${z.prettifyError(result.error)}`);
};

/**
 * The settings of an attempt: its rules, each bare file tool scoped to the worktree (ADR 0093),
 * the rules every attempt denies, and the sandbox. `--tools` still decides which tools exist.
 */
export function attemptSettings({
  allow,
  deny,
  sandbox,
  configDirs = {},
  toolchain = {},
}: AttemptPermissions): AttemptSettings {
  const credentials = credentialsOf(configDirs);
  const allowRead = toolchainReads(
    toolchain,
    credentials.files.map(({ path }) => path),
  );
  return valid({
    permissions: {
      allow: [...new Set(allow.map(scopedRule))],
      deny: [...new Set([...deny, ...alwaysDenied(allow)])],
      // ADR 0160: sandboxed commands lose the home directory and the other user roots.
      ...(sandbox ? { blockReadsOutsideWorkingDirectories: true } : {}),
    },
    // ADR 0151: no Co-Authored-By trailer, pull request footer or session URL from the tool.
    attribution: { commit: '', pr: '', sessionUrl: false },
    // ADR 0042: by default a sandbox that cannot start lets commands run unsandboxed. ADR 0087: by
    // default it runs every sandboxed command whatever the allow rules say, and lets it read the
    // machine's credentials, wherever a variable moved them (ADR 0160). ADR 0162: the block's
    // command part takes a toolchain under the home, whose folders `allowRead` re-opens.
    ...(sandbox
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: false,
            credentials,
            ...(allowRead.length > 0
              ? { filesystem: { allowRead, denyRead: allowRead.flatMap(npmConfigsIn) } }
              : {}),
          },
        }
      : {}),
  });
}

/** Writes the settings as JSON once they pass the schema; throws, writing nothing, otherwise. */
export function writeAttemptSettings(file: string, settings: AttemptSettings): void {
  writeFileSync(file, `${JSON.stringify(valid(settings), null, 2)}\n`);
}
