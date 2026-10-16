// Writing an attempt's `claude --settings` file (ADR 0045): always from an AttemptSettings that
// passed its schema, so the file is never one claude would drop.

import type { AttemptSettings } from '../schemas/attempt-settings.ts';

export interface AttemptPermissions {
  /** The brewer's tools.allow with the repository's toolchain commands (ADR 0023). */
  allow: readonly string[];
  /** The brewer's tools.deny. */
  deny: readonly string[];
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
}

/** The settings of an attempt: its rules, the rules every attempt denies, and the sandbox. */
export function attemptSettings(_permissions: AttemptPermissions): AttemptSettings {
  throw new Error('not implemented');
}

/** Writes the settings as JSON once they pass the schema; throws, writing nothing, otherwise. */
export function writeAttemptSettings(_file: string, _settings: AttemptSettings): void {
  throw new Error('not implemented');
}
