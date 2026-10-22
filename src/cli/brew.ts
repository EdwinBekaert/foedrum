// `foedrum brew`, the interactive driver of one batch (ADR 0123).

import type { OrderTarget } from '../schemas/commands.ts';
import type { Surface } from '../schemas/events.ts';
import type { ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';

/** What `foedrum brew` brews, as whom, and who asked. */
export interface BrewRequest {
  target: OrderTarget;
  /** The driver's owner: its lock's and its leases' (ADR 0037). */
  owner: string;
  /** Who runs it, recorded on an order it makes (ADR 0105). */
  by: string;
  via: Surface;
}

/** The driver's owner: `--as`, else the Claude Code session's, else why there is none. */
export const brewOwner = (
  _as: string | undefined,
  _env: Readonly<Record<string, string | undefined>>,
): { owner: string } | { refused: string } => {
  throw new Error('not implemented');
};

/** Brews the batch of `request.target` until it stops; the exit code of ADR 0123. */
export const runBrew = async (
  _setup: ServeSetup,
  _shell: ServeShell,
  _request: BrewRequest,
): Promise<number> => {
  throw new Error('not implemented');
};
