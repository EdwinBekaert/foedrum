// The owner of an interactive driver (ADR 0123): the name its lock and its leases carry, which
// `foedrum brew` drives under and `foedrum takeover` hands a batch to (ADR 0124).

import { PathSafeId } from '../schemas/ids.ts';

/** The variable Claude Code sets to its session's id in its tools' processes. */
const SESSION = 'CLAUDE_CODE_SESSION_ID';

/**
 * The driver's owner (ADR 0123): `--as`, else `session-<id>` of the Claude Code session the command
 * runs in, which a resume by id keeps; else why there is none.
 */
export const brewOwner = (
  as: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): { owner: string } | { refused: string } => {
  if (as !== undefined) return { owner: as };
  const id = env[SESSION];
  if (id === undefined || id === '') {
    return { refused: `no Claude Code session names the driver (${SESSION}); give --as <name>` };
  }
  const owner = `session-${id.toLowerCase()}`;
  if (PathSafeId.safeParse(owner).success) return { owner };
  return {
    refused: `the Claude Code session ${JSON.stringify(id)} names no driver; give --as <name>`,
  };
};
