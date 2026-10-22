// `foedrum resume <batch> [<step>[#<n>]]` (ADR 0126): opens a finished brewer attempt's own Claude
// Code session in its worktree, with its settings file written again, while the batch's and the
// attempt's leases claim it. resume-main.ts gives it the real machine; unit tests give fakes.

import type { EventStore } from '../engine/event-store.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { ResumeCommand } from '../schemas/commands.ts';
import type { AttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import type { CliResult } from './run.ts';
import type { ServeRepository, ServeSetup } from './serve-config.ts';

/** What resume needs of serve's setup: where the attempts ran and how their brewers are set up. */
export type ResumeSetup = Pick<
  ServeSetup,
  'workRoot' | 'repositories' | 'models' | 'brewers' | 'claude' | 'sandbox'
>;

/** What resume needs from the machine. */
export interface ResumeShell {
  /** The Brewery's root: the event store is `.foedrum/index.db` in it. */
  cwd: string;
  /** Opens the event store for writing its leases, or `undefined` when there is none. */
  openStore: (path: string) => EventStore | undefined;
  /** Serve's setup of the Brewery, or serve's problems. */
  setup: () => Promise<
    { kind: 'ready'; setup: ResumeSetup } | { kind: 'refused'; problems: string[] }
  >;
  /** The attempt worktrees of a repository. */
  worktrees: (repository: ServeRepository) => Promise<Pick<AttemptWorktrees, 'recreate'>>;
  /** Whether Claude Code keeps the session `id` on this machine. */
  sessionFound: (id: string) => boolean;
  /** Writes an attempt's settings file, making its folder. */
  writeSettings: (file: string, settings: AttemptSettings) => void;
  /** Whether this runs inside a Claude Code session, which cannot hand its terminal over. */
  nested: boolean;
  /** Runs `program` in the foreground in `cwd` with the terminal's stdio; its exit code. */
  claude: (program: string, args: readonly string[], cwd: string) => Promise<number>;
  now: () => Date;
  /** Calls `beat` every `everyMs` until the returned function is called. */
  heartbeat: (everyMs: number, beat: () => void) => () => void;
  /** This process's id, which names the leases' owner. */
  pid: number;
}

/** Runs `foedrum resume`. */
export const runResume = async (_input: ResumeCommand, _shell: ResumeShell): Promise<CliResult> => {
  throw new Error('not implemented');
};
