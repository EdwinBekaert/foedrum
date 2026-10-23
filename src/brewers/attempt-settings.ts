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
}

const CONFIG_DIRS = ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'] as const;

/** The variables that move a login out of the paths `sandboxCredentials` names (ADR 0160). */
export type ConfigDirs = Partial<Record<(typeof CONFIG_DIRS)[number], string>>;

/** The variables of `env` that move a login. */
export const configDirsOf = (env: Readonly<Record<string, string | undefined>>): ConfigDirs =>
  Object.fromEntries(
    CONFIG_DIRS.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  );

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
}: AttemptPermissions): AttemptSettings {
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
    // machine's credentials, wherever a variable moved them (ADR 0160).
    ...(sandbox
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: false,
            credentials: credentialsOf(configDirs),
          },
        }
      : {}),
  });
}

/** Writes the settings as JSON once they pass the schema; throws, writing nothing, otherwise. */
export function writeAttemptSettings(file: string, settings: AttemptSettings): void {
  writeFileSync(file, `${JSON.stringify(valid(settings), null, 2)}\n`);
}
