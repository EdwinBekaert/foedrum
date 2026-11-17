// Writing an attempt's `claude --settings` file (ADR 0046): always from an AttemptSettings that
// passed its schema, so the file is never one claude would drop.

import { writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { AttemptSettings, alwaysDenied, scopedRule } from '../schemas/attempt-settings.ts';
import { z } from '../schemas/zod.ts';

export interface AttemptPermissions {
  /** The brewer's tools.allow with the repository's toolchain commands (ADR 0023). */
  allow: readonly string[];
  /** The brewer's tools.deny. */
  deny: readonly string[];
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  /** The driver's home and PATH, whose toolchain folders sandboxed commands may read (ADR 0162). */
  toolchain?: Toolchain;
}

/** The variables of the driver's environment the toolchain's folders are found from (ADR 0162). */
export interface Toolchain {
  HOME?: string;
  PATH?: string;
}

/** The variables of `env` the toolchain's folders are found from: those that are set. */
export const toolchainOf = ({
  HOME,
  PATH,
}: Readonly<Record<string, string | undefined>>): Toolchain => ({
  ...(HOME === undefined ? {} : { HOME }),
  ...(PATH === undefined ? {} : { PATH }),
});

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

/**
 * The folders of the driver's toolchain that sandboxed commands may read under the block (ADR 0162):
 * Homebrew's prefix on Linux, and each PATH folder under the home, as a layout's prefix or as it is,
 * never its parent nor the home itself. Not a folder with a glob character, which a sandbox path
 * reads as a wildcard. The PATH is the person's own: a folder on it is re-opened whatever it holds
 * (ADR 0414).
 */
const toolchainReads = ({ HOME = '', PATH = '' }: Toolchain): string[] => {
  const home = folderOf(HOME);
  const reads = PATH.split(':').flatMap((entry) => {
    const folder = folderOf(entry);
    if (folder === `${LINUXBREW}/bin` || folder === `${LINUXBREW}/sbin`) return [LINUXBREW];
    if (home === '' || !folder.startsWith(`${home}/`)) return [];
    const names = folder.slice(home.length + 1).split('/');
    return [posix.join(home, ...names.slice(0, keptOf(names)))];
  });
  return [...new Set(reads)].filter((folder) => !/[*?[]/.test(folder));
};

/**
 * npm's configuration files anywhere in a re-opened folder: a prefix's global `etc/npmrc` and the
 * npm package's builtin `npmrc` can hold an npm login, which the read block hides as `~/.npmrc`
 * (ADR 0162).
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
  toolchain = {},
}: AttemptPermissions): AttemptSettings {
  const allowRead = toolchainReads(toolchain);
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
    // default it runs every sandboxed command whatever the allow rules say. ADR 0414: it names no
    // login place; the sandbox keeps the person's logins from a brewer's commands. ADR 0162: the
    // block's command part takes a toolchain under the home, whose folders `allowRead` re-opens.
    ...(sandbox
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: false,
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
