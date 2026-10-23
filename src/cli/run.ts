// The terminal surface of the command layer (ADR 0019): turns `foedrum <command> [args]` into a
// command from the registry, runs its handler and answers with the exit code and the output.
// main.ts gives it the real machine; unit tests give it fakes.

import { parseArgs } from 'node:util';
import type { EventStore } from '../engine/event-store.ts';
import type { State } from '../engine/fold.ts';
import type { ClaimHost } from '../engine/issue-claims.ts';
import type { Recipes } from '../engine/recipes.ts';
import type { BreweryConfig } from '../schemas/brewery-config.ts';
import type { BrewCommand, ResumeCommand } from '../schemas/commands.ts';
import type { Surface } from '../schemas/events.ts';
import type { z } from '../schemas/zod.ts';
import { columns } from './columns.ts';
import { commands } from './commands.ts';
import type { DoctorFacts } from './doctor.ts';
import type { BranchReading } from './kept-branches.ts';

/** What the commands need from the machine. */
export interface CliContext {
  /** The Brewery's root: the event store is `.foedrum/index.db` in it. */
  cwd: string;
  gatherDoctorFacts: () => Promise<DoctorFacts>;
  /** Opens the event store at `path` for reading only, or `undefined` when there is none. */
  openStore: (path: string) => EventStore | undefined;
  /**
   * Opens the event store at `path` for a command that changes state, or `undefined` when there
   * is none: a command never creates one.
   */
  openWritableStore: (path: string) => EventStore | undefined;
  /**
   * Loads the Brewery's recipes, which decide where a batch goes next. Only a command that
   * changes state calls it.
   */
  recipes: () => Recipes;
  /** Who issues the command: the name its events record (ADR 0019). */
  user: () => string;
  /** Where the command comes from: the surface its events record. */
  surface: Surface;
  now: () => Date;
  /**
   * What git says of the task-tree branches the cleanup keeps (`Claims.unpushed`, ADR 0084), for
   * `foedrum status` (ADR 0092). Called only when there are any.
   */
  readKeptBranches: (
    state: State,
    unpushed: ReadonlyMap<string, string>,
  ) => Promise<ReadonlyMap<string, BranchReading>>;
  /**
   * The Brewery's `foedrum.jsonc`, checked against its schema; throws with one line when it is
   * missing or does not pass. Only `order` of a target issue reads it (ADR 0105).
   */
  config: () => BreweryConfig;
  /**
   * The claim refs on the GitHub host `config` names, through gh's own login (ADR 0073). Only
   * `order` of a target issue calls it.
   */
  claims: (config: BreweryConfig) => ClaimHost;
  /** Runs the Cellar until Ctrl+C (ADR 0063); its notices go straight to the terminal. */
  serve: () => Promise<CliResult>;
  /**
   * Brews one issue's batch until it stops (ADR 0123), as `as` or the Claude Code session's
   * owner, recording who issued it and from where on an order it makes; its lines go straight to
   * the terminal.
   */
  brew: (input: BrewCommand, issued: { by: string; via: Surface }) => Promise<CliResult>;
  /** The environment, for the Claude Code session that names a driver (ADR 0123, ADR 0124). */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Opens a finished attempt's session in its worktree (ADR 0126), or takes a running batch over
   * and continues the session of its step (ADR 0127), recording who issued it and from where;
   * claude has the terminal.
   */
  resume: (input: ResumeCommand, issued: { by: string; via: Surface }) => Promise<CliResult>;
}

export interface CliResult {
  /** 0 done, 1 the command failed, 2 the command line is wrong. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

const HELP = new Set(['-h', '--help']);
const SEE_HELP = 'run foedrum --help for the commands';

// Every control character but the line feed, DEL and the C1 controls: model-written text in the
// event log (a Stuck summary, a failure reason) must not move the cursor, rewrite earlier lines
// or set the clipboard (OSC 52) when it is printed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is its job
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** The text with each control character but the line feed shown as a `\uXXXX` escape. */
export const printable = (text: string): string =>
  text.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

const usageError = (line: string): CliResult => ({ exitCode: 2, stdout: '', stderr: `${line}\n` });

/**
 * The surfaces `--via` may name (ADR 0125): the terminal's own and the plugin's, which runs the
 * terminal. It changes only what the events record, never what a command may do (ADR 0019).
 */
const VIA: readonly Surface[] = ['plugin', 'terminal'];

/**
 * `foedrum serve`, the Cellar (ADR 0063): a program that runs until Ctrl+C, not a command of the
 * command layer that a comment or the plugin could issue, so it is not in the registry.
 */
const SERVE = { name: 'serve', summary: "Run the Cellar: brew the Brewery's batches until Ctrl+C" };

const usage = (): CliResult => {
  const serve = [SERVE.name, SERVE.summary];
  const rows = commands.map(({ name, summary, positionals, optional = [], rest, ...more }) => [
    [
      name,
      ...positionals.map((positional) => `<${positional}>`),
      ...optional.map((positional) => `[<${positional}>]`),
      ...(rest === undefined ? [] : [`<${rest}>...`]),
      ...Object.entries(more.options ?? {}).map(([option, value]) => `[--${option} <${value}>]`),
      ...(more.flags ?? []).map((flag) => `[--${flag}]`),
    ].join(' '),
    summary,
  ]);
  const lines = [
    'Usage: foedrum <command> [arguments]',
    '',
    'Commands:',
    ...columns([serve, ...rows]),
    '',
    `Every command takes --via <${VIA.join('|')}> but serve: the surface its events record.`,
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
};

// The first problem the schema found, named as on the command line: with the argument it is about,
// or without one when it is about the whole list.
const invalid = (
  prefix: string,
  input: Record<string, string | string[] | true>,
  error: z.ZodError,
): CliResult => {
  const [issue] = error.issues;
  const field = String(issue?.path[0]);
  const given = input[field];
  const value = Array.isArray(given) ? given[Number(issue?.path[1])] : given;
  const shown = value === undefined ? '' : ` ${JSON.stringify(value)}`;
  return usageError(`${prefix}: invalid <${field}>${shown}: ${issue?.message}`);
};

/** Runs `foedrum <argv>`: exit 2 with one line on stderr when the command line is wrong. */
export const runCli = async (argv: readonly string[], context: CliContext): Promise<CliResult> => {
  const { exitCode, stdout, stderr } = await runCommand(argv, context);
  return { exitCode, stdout: printable(stdout), stderr: printable(stderr) };
};

const runCommand = async (argv: readonly string[], context: CliContext): Promise<CliResult> => {
  const [name, ...rest] = argv;
  if (name === undefined) return usageError(`foedrum: no command given; ${SEE_HELP}`);
  if (HELP.has(name)) return usage();
  if (name.startsWith('-')) {
    return usageError(`foedrum: unknown option ${JSON.stringify(name)}; ${SEE_HELP}`);
  }
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined && name !== SERVE.name) {
    return usageError(`foedrum: unknown command ${JSON.stringify(name)}; ${SEE_HELP}`);
  }
  const prefix = `foedrum ${name}`;
  // The options the command takes, each with a value or, a flag, without: a field of its input.
  const known = Object.keys(command?.options ?? {});
  const flags = command?.flags ?? [];
  // Not strict, so an unknown option is a token this can name instead of parseArgs' message.
  const { tokens } = parseArgs({
    args: rest,
    options: {
      help: { type: 'boolean', short: 'h' },
      ...(command === undefined ? {} : { via: { type: 'string' } as const }),
      ...Object.fromEntries(known.map((option) => [option, { type: 'string' } as const])),
      ...Object.fromEntries(flags.map((flag) => [flag, { type: 'boolean' } as const])),
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = tokens.filter((token) => token.kind === 'option');
  if (options.some((option) => option.name === 'help')) return usage();
  const optionValues: Record<string, string | true> = {};
  let surface = context.surface;
  for (const option of options) {
    if (command !== undefined && option.name === 'via') {
      if (option.value === undefined) return usageError(`${prefix}: --via needs a value`);
      const via = VIA.find((candidate) => candidate === option.value);
      if (via === undefined) {
        return usageError(
          `${prefix}: --via takes ${VIA.join(' or ')}, not ${JSON.stringify(option.value)}`,
        );
      }
      surface = via;
      continue;
    }
    if (flags.includes(option.name)) {
      if (option.value !== undefined) {
        return usageError(`${prefix}: ${option.rawName} takes no value`);
      }
      optionValues[option.name] = true;
      continue;
    }
    if (!known.includes(option.name)) {
      return usageError(`${prefix}: unknown option "${option.rawName}"`);
    }
    if (option.value === undefined) return usageError(`${prefix}: ${option.rawName} needs a value`);
    optionValues[option.name] = option.value;
  }
  const values = tokens.flatMap((token) => (token.kind === 'positional' ? [token.value] : []));
  if (command === undefined) {
    const [extra] = values;
    if (extra !== undefined) return usageError(`${prefix}: unexpected argument "${extra}"`);
    return context.serve();
  }
  const { positionals: required, optional = [], rest: restField } = command;
  // The optional ones that were given, in order.
  const given = optional.slice(0, Math.max(0, values.length - required.length));
  const positionals = [...required, ...given];
  const extra = values[required.length + optional.length];
  if (extra !== undefined && restField === undefined) {
    return usageError(`${prefix}: unexpected argument "${extra}"`);
  }
  const missing = [...required, ...(restField === undefined ? [] : [restField])][values.length];
  if (missing !== undefined) return usageError(`${prefix}: missing <${missing}>`);
  const input: Record<string, string | string[] | true> = Object.fromEntries(
    positionals.map((field, i) => [field, values[i] ?? '']),
  );
  if (restField !== undefined) input[restField] = values.slice(positionals.length);
  Object.assign(input, optionValues);
  try {
    const result = await command.run({ command: name, ...input }, { ...context, surface });
    return 'invalid' in result ? invalid(prefix, input, result.invalid) : result;
  } catch (error) {
    // A store that cannot be read, for example: one line, escaped like every other output.
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: '', stderr: `${prefix}: ${message}\n` };
  }
};
