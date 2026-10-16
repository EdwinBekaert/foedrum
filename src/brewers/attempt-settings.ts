// Writing an attempt's `claude --settings` file (ADR 0045): always from an AttemptSettings that
// passed its schema, so the file is never one claude would drop.

import { writeFileSync } from 'node:fs';
import { AttemptSettings, alwaysDenied } from '../schemas/attempt-settings.ts';
import { z } from '../schemas/zod.ts';

export interface AttemptPermissions {
  /** The brewer's tools.allow with the repository's toolchain commands (ADR 0023). */
  allow: readonly string[];
  /** The brewer's tools.deny. */
  deny: readonly string[];
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
}

/** The settings as the schema reads them; throws with every problem when it does not. */
const valid = (settings: unknown): AttemptSettings => {
  const result = AttemptSettings.safeParse(settings);
  if (result.success) return result.data;
  throw new Error(`The attempt settings are not valid:\n${z.prettifyError(result.error)}`);
};

/** The settings of an attempt: its rules, the rules every attempt denies, and the sandbox. */
export function attemptSettings({ allow, deny, sandbox }: AttemptPermissions): AttemptSettings {
  return valid({
    permissions: { allow: [...allow], deny: [...new Set([...deny, ...alwaysDenied(allow)])] },
    // ADR 0042: by default a sandbox that cannot start lets commands run unsandboxed.
    ...(sandbox
      ? { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }
      : {}),
  });
}

/** Writes the settings as JSON once they pass the schema; throws, writing nothing, otherwise. */
export function writeAttemptSettings(file: string, settings: AttemptSettings): void {
  writeFileSync(file, `${JSON.stringify(valid(settings), null, 2)}\n`);
}
