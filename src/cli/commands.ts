// The command registry (ADR 0019): one schema and one handler per command. Surfaces turn their
// input into a command's input and run it; run.ts is the terminal's. doctor, status and replay
// only read, so they append nothing (ADR 0030). #37 adds the commands that change state.

import { join } from 'node:path';
import type { StoredEvent } from '../engine/event-store.ts';
import { fold, InvalidLogError, type State } from '../engine/fold.ts';
import { batchOf } from '../engine/state-branch.ts';
import { DoctorCommand, ReplayCommand, StatusCommand } from '../schemas/commands.ts';
import type { z } from '../schemas/zod.ts';
import { diagnose, formatDiagnosis } from './doctor.ts';
import { formatReplay } from './replay.ts';
import type { CliContext, CliResult } from './run.ts';
import { formatStatus } from './status.ts';

/** A command as surfaces see it: its schema and handler behind `run`. */
export interface RegisteredCommand {
  name: string;
  summary: string;
  /** The positional arguments, in order: each is a field of the command's input. */
  positionals: readonly string[];
  /** Validates the input against the command's schema, then runs its handler. */
  run: (input: unknown, context: CliContext) => Promise<CliResult | { invalid: z.ZodError }>;
}

interface CommandDefinition<S extends z.ZodType> {
  name: string;
  summary: string;
  positionals: readonly string[];
  schema: S;
  handler: (input: z.output<S>, context: CliContext) => Promise<CliResult>;
}

const define = <S extends z.ZodType>({
  schema,
  handler,
  ...command
}: CommandDefinition<S>): RegisteredCommand => ({
  ...command,
  run: async (input, context) => {
    const parsed = schema.safeParse(input);
    return parsed.success ? handler(parsed.data, context) : { invalid: parsed.error };
  },
});

/** The Brewery's event store: `.foedrum/index.db` in its root. */
const storePath = (root: string): string => join(root, '.foedrum', 'index.db');

const done = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: '' });

const failed = (command: string, message: string): CliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `foedrum ${command}: ${message}\n`,
});

// Reads every event of the Brewery's store and folds them; one line when there is no store or the
// fold refuses the log. Never writes (ADR 0030).
const readBrewery = (
  command: string,
  { cwd, openStore }: CliContext,
  show: (events: readonly StoredEvent[], state: State) => CliResult,
): CliResult => {
  const path = storePath(cwd);
  const store = openStore(path);
  if (store === undefined) return failed(command, `no event store at ${path}`);
  try {
    const events = store.eventsAfter(0);
    let state: State;
    try {
      state = fold(events.map(({ event }) => event));
    } catch (error) {
      if (error instanceof InvalidLogError) return failed(command, error.message);
      throw error;
    }
    return show(events, state);
  } finally {
    store.close();
  }
};

export const commands: readonly RegisteredCommand[] = [
  define({
    name: 'doctor',
    summary: 'Check the tools Foedrum needs and the isolation level',
    positionals: [],
    schema: DoctorCommand,
    handler: async (_input, { gatherDoctorFacts }) => {
      const diagnosis = diagnose(await gatherDoctorFacts());
      return { ...done(formatDiagnosis(diagnosis)), exitCode: diagnosis.ok ? 0 : 1 };
    },
  }),
  define({
    name: 'status',
    summary: 'List the batches and their lanes',
    positionals: [],
    schema: StatusCommand,
    handler: async (_input, context) =>
      readBrewery('status', context, (_events, state) => done(formatStatus(state))),
  }),
  define({
    name: 'replay',
    summary: "Show a batch's events and its folded state",
    positionals: ['batch'],
    schema: ReplayCommand,
    handler: async ({ batch: id }, context) =>
      readBrewery('replay', context, (events, state) => {
        const batch = state.batches.get(id);
        if (batch === undefined) return failed('replay', `no batch ${id} in the event store`);
        return done(
          formatReplay(
            batch,
            events.filter(({ event }) => batchOf(event) === id),
          ),
        );
      }),
  }),
];
