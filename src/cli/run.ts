// The terminal surface of the command layer (ADR 0019): turns `foedrum <command> [args]` into a
// command from the registry, runs its handler and answers with the exit code and the output.
// main.ts gives it the real machine; unit tests give it fakes.

import type { EventStore } from '../engine/event-store.ts';
import type { DoctorFacts } from './doctor.ts';

/** What the commands need from the machine. */
export interface CliContext {
  /** The Brewery's root: the event store is `.foedrum/index.db` in it. */
  cwd: string;
  gatherDoctorFacts: () => Promise<DoctorFacts>;
  /** Opens the event store at `path`, or `undefined` when there is none. */
  openStore: (path: string) => EventStore | undefined;
}

export interface CliResult {
  /** 0 done, 1 the command failed, 2 the command line is wrong. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const runCli = async (
  _argv: readonly string[],
  _context: CliContext,
): Promise<CliResult> => {
  throw new Error('not implemented');
};
