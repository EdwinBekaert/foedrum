// The terminal surface of the command layer (ADR 0019): turns `foedrum <command> [args]` into a
// command from the registry, runs its handler and answers with the exit code and the output.
// main.ts gives it the real machine; unit tests give it fakes.

import { parseArgs } from 'node:util';
import type { EventStore } from '../engine/event-store.ts';
import type { z } from '../schemas/zod.ts';
import { columns } from './columns.ts';
import { commands } from './commands.ts';
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

const HELP = new Set(['-h', '--help']);
const SEE_HELP = 'run foedrum --help for the commands';

const usageError = (line: string): CliResult => ({ exitCode: 2, stdout: '', stderr: `${line}\n` });

const usage = (): CliResult => {
  const rows = commands.map(({ name, summary, positionals }) => [
    [name, ...positionals.map((positional) => `<${positional}>`)].join(' '),
    summary,
  ]);
  const lines = ['Usage: foedrum <command> [arguments]', '', 'Commands:', ...columns(rows)];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
};

// The first problem the schema found, named as on the command line.
const invalid = (prefix: string, input: Record<string, string>, error: z.ZodError): CliResult => {
  const [issue] = error.issues;
  const field = String(issue?.path[0]);
  return usageError(
    `${prefix}: invalid <${field}> ${JSON.stringify(input[field])}: ${issue?.message}`,
  );
};

/** Runs `foedrum <argv>`: exit 2 with one line on stderr when the command line is wrong. */
export const runCli = async (argv: readonly string[], context: CliContext): Promise<CliResult> => {
  const [name, ...rest] = argv;
  if (name === undefined) return usageError(`foedrum: no command given; ${SEE_HELP}`);
  if (HELP.has(name)) return usage();
  if (name.startsWith('-')) {
    return usageError(`foedrum: unknown option ${JSON.stringify(name)}; ${SEE_HELP}`);
  }
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) {
    return usageError(`foedrum: unknown command ${JSON.stringify(name)}; ${SEE_HELP}`);
  }
  const prefix = `foedrum ${name}`;
  // Not strict, so an unknown option is a token this can name instead of parseArgs' message.
  const { tokens } = parseArgs({
    args: rest,
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = tokens.filter((token) => token.kind === 'option');
  if (options.some((option) => option.name === 'help')) return usage();
  // No command takes an option yet (#37 adds them).
  const [unknown] = options;
  if (unknown !== undefined) return usageError(`${prefix}: unknown option "${unknown.rawName}"`);
  const values = tokens.flatMap((token) => (token.kind === 'positional' ? [token.value] : []));
  const extra = values[command.positionals.length];
  if (extra !== undefined) return usageError(`${prefix}: unexpected argument "${extra}"`);
  const missing = command.positionals[values.length];
  if (missing !== undefined) return usageError(`${prefix}: missing <${missing}>`);
  const input = Object.fromEntries(command.positionals.map((field, i) => [field, values[i] ?? '']));
  const result = await command.run({ command: name, ...input }, context);
  return 'invalid' in result ? invalid(prefix, input, result.invalid) : result;
};
