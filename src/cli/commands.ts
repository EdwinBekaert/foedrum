// The command registry (ADR 0019): one schema and one handler per command. Surfaces turn their
// input into a command's input and run it; run.ts is the terminal's. doctor, status, stuck and
// replay only read, so they append nothing (ADR 0030). The others turn their input into one of
// the engine's human commands and append its events through the command log, recorded with who
// issued it and from where (ADR 0025).

import { join } from 'node:path';
import { nextBatchId, targetBatchId } from '../engine/batch-id.ts';
import { defaultLeaseMs, takeOver } from '../engine/batch-leases.ts';
import { type CommandLog, createCommandLog } from '../engine/command-log.ts';
import { type HumanCommand, orderRefusal } from '../engine/decide.ts';
import type { EventStore, StoredEvent } from '../engine/event-store.ts';
import { type Batch, fold, InvalidLogError, type State } from '../engine/fold.ts';
import { type ClaimHost, claimIssue } from '../engine/issue-claims.ts';
import { batchOf } from '../engine/state-branch.ts';
import { worktreeClaims } from '../engine/worktree-claims.ts';
import type { BreweryConfig } from '../schemas/brewery-config.ts';
import {
  AnswerCommand,
  BrewCommand,
  CancelCommand,
  CELLAR_OWNER,
  DoctorCommand,
  OrderCommand,
  RecipeCommand,
  ReplayCommand,
  ResumeCommand,
  RetryCommand,
  RewindCommand,
  SkipCommand,
  StatusCommand,
  StuckCommand,
  TakeoverCommand,
} from '../schemas/commands.ts';
import type { OrderRef, Surface } from '../schemas/events.ts';
import type { z } from '../schemas/zod.ts';
import { diagnose, formatDiagnosis } from './doctor.ts';
import { brewOwner } from './driver-owner.ts';
import { keptBranchLines } from './kept-branches.ts';
import { formatReplay } from './replay.ts';
import type { CliContext, CliResult } from './run.ts';
import { NAME_THE_BREWERY } from './serve-config.ts';
import { describeLane, formatStatus } from './status.ts';
import { formatStuck } from './stuck.ts';

/** A command as surfaces see it: its schema and handler behind `run`. */
export interface RegisteredCommand {
  name: string;
  summary: string;
  /**
   * Whether it may append events (ADR 0030): such a command opens the store for writing, and its
   * events record who issued it and from where. A read-only one never writes.
   */
  changesState: boolean;
  /** The positional arguments, in order: each is a field of the command's input. */
  positionals: readonly string[];
  /** The positional arguments after those that may be left out, in order. */
  optional?: readonly string[];
  /** The field that takes the positional arguments after those, one or more, as a list. */
  rest?: string;
  /** The options it takes, each with a value and a field of its own: the value's name, by option. */
  options?: Readonly<Record<string, string>>;
  /** The options it takes without a value, each a field of its own that is true when given. */
  flags?: readonly string[];
  /** Why the plugin does not carry it, when it does not (ADR 0125); the parity test reads it. */
  terminalOnly?: string;
  /** Validates the input against the command's schema, then runs its handler. */
  run: (input: unknown, context: CliContext) => Promise<CliResult | { invalid: z.ZodError }>;
}

interface CommandDefinition<S extends z.ZodType> {
  name: string;
  summary: string;
  changesState: boolean;
  positionals: readonly string[];
  optional?: readonly string[];
  rest?: string;
  options?: Readonly<Record<string, string>>;
  flags?: readonly string[];
  terminalOnly?: string;
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
// fold refuses the log. Never writes (ADR 0030). The store closes once `show` is done.
const readBrewery = async (
  command: string,
  { cwd, openStore }: CliContext,
  show: (
    events: readonly StoredEvent[],
    state: State,
    store: EventStore,
  ) => CliResult | Promise<CliResult>,
): Promise<CliResult> => {
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
    return await show(events, state, store);
  } finally {
    store.close();
  }
};

/** Who issues a human command about `batchId`, and from where (ADR 0019). */
type Issued = (batchId: string) => { batchId: string; by: string; via: Surface };

// Issues the human command `build` makes from the folded state (or the reason it makes none)
// through the command log, so it is decided against the latest events (ADR 0025), and says where
// the batch is now. `state` folds the latest events each time, for a build that waits on the code
// host. Never creates a store.
const changeBrewery = async (
  command: string,
  context: CliContext,
  build: (
    state: () => State,
    issued: Issued,
  ) => HumanCommand | { refused: string } | Promise<HumanCommand | { refused: string }>,
): Promise<CliResult> =>
  writeBrewery(command, context, async (log) => {
    const { user, surface, now } = context;
    const issued: Issued = (batchId) => ({ batchId, by: user(), via: surface });
    const human = await build(() => log.state(), issued);
    if ('refused' in human) return failed(command, human.refused);
    const decision = log.issue(human, now());
    if (decision.kind === 'refused') return failed(command, decision.reason);
    // Accepted, so the batch exists.
    const { lane, detail } = describeLane(log.state().batches.get(human.batchId) as Batch);
    return done(`${human.batchId} ${lane}${detail === '' ? '' : `: ${detail}`}\n`);
  });

// Runs `use` on the command log of the Brewery's store, opened for writing and closed after; one
// line when there is no store or the fold refuses the log. Never creates a store.
const writeBrewery = async (
  command: string,
  { cwd, openWritableStore, recipes }: CliContext,
  use: (log: CommandLog) => Promise<CliResult>,
): Promise<CliResult> => {
  const path = storePath(cwd);
  const store = openWritableStore(path);
  if (store === undefined) return failed(command, `no event store at ${path}`);
  try {
    return await use(createCommandLog({ store, recipes: recipes() }));
  } catch (error) {
    if (error instanceof InvalidLogError) return failed(command, error.message);
    throw error;
  } finally {
    store.close();
  }
};

/** What `foedrum order <alias>#<n>` claims in, from foedrum.jsonc, or why it cannot. */
const claimOf = (
  alias: string,
  config: BreweryConfig,
):
  | { repo: string; alias: string; brewery: string; config: BreweryConfig }
  | { refused: string } => {
  const found = Object.entries(config.repositories).find(
    ([, repository]) => repository.alias === alias,
  );
  if (found === undefined)
    return { refused: `foedrum.jsonc names no repository with the alias ${alias}` };
  const [repo, { intake }] = found;
  // Without an intake, serve would neither mark nor release the claim, nor route the batch.
  if (intake === undefined) {
    return {
      refused: `${repo} has no intake in foedrum.jsonc; order only issues of a repository with one`,
    };
  }
  // The claim records the Brewery that holds it (ADR 0043).
  if (config.brewery === undefined) return { refused: NAME_THE_BREWERY };
  return { repo, alias, brewery: config.brewery, config };
};

/** The questions `batch` asks while Stuck on `needs_input`, in order; none otherwise. */
const questionsOf = (state: State, batchId: string): readonly string[] => {
  const lane = state.batches.get(batchId)?.lane;
  return lane?.kind === 'stuck' && lane.reason.kind === 'needs_input'
    ? lane.reason.questions.map(({ q }) => q)
    : [];
};

/** The target repository an order claims its issue in, and the Brewery the claim records. */
export interface OrderClaim {
  repo: string;
  alias: string;
  brewery: string;
}

/**
 * The human command that orders `order` again (ADR 0105), or why it cannot: refused while
 * `orderRefusal` says so, then a target issue is claimed first, and the batch takes the issue's
 * next id. `foedrum order` and `foedrum brew` order through it.
 */
export const orderIssue = async (
  state: () => State,
  order: OrderRef,
  claim: OrderClaim | undefined,
  { claims, now, issued }: { claims: () => ClaimHost; now: Date; issued: Issued },
): Promise<HumanCommand | { refused: string }> => {
  const { issue } = order;
  // Before the claim, so a refused order claims nothing; decide checks it again.
  const refused = orderRefusal(state(), order);
  if (refused !== undefined) return { refused };
  if (claim === undefined)
    return { kind: 'order_again', ...issued(nextBatchId(state(), issue)), order };
  const { repo, brewery } = claim;
  const outcome = await claimIssue(claims(), { repo, issue, brewery, now: now.toISOString() });
  if (outcome.kind === 'taken') {
    const by = outcome.by ?? 'a ref whose record cannot be read';
    return { refused: `${repo}#${issue} is claimed by ${by}` };
  }
  return { kind: 'order_again', ...issued(targetBatchId(state(), claim.alias, issue)), order };
};

export const commands: readonly RegisteredCommand[] = [
  define({
    name: 'doctor',
    summary: 'Check the tools Foedrum needs and the isolation level',
    changesState: false,
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
    changesState: false,
    positionals: [],
    schema: StatusCommand,
    handler: async (_input, context) =>
      readBrewery('status', context, async (_events, state, store) => {
        // The task-tree branches the cleanup keeps (ADR 0084), read only when there are any.
        const unpushed = worktreeClaims(state, []).unpushed ?? new Map<string, string>();
        const readings =
          unpushed.size === 0 ? new Map() : await context.readKeptBranches(state, unpushed);
        // The batches an interactive driver holds now, by its owner (ADR 0123).
        const interactive = new Map(
          store
            .batchLeases(context.now())
            .filter(({ owner }) => owner !== CELLAR_OWNER)
            .map(({ batchId, owner }) => [batchId, owner]),
        );
        return done(formatStatus(state, keptBranchLines(unpushed, readings), interactive));
      }),
  }),
  define({
    name: 'stuck',
    summary: 'List the Stuck batches with their options and questions',
    changesState: false,
    positionals: [],
    schema: StuckCommand,
    handler: async (_input, context) =>
      readBrewery('stuck', context, (_events, state) => done(formatStuck(state))),
  }),
  define({
    name: 'replay',
    summary: "Show a batch's events and its folded state",
    changesState: false,
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
  define({
    name: 'resume',
    summary: "Open a finished brewer attempt's Claude Code session in its worktree",
    changesState: false,
    positionals: ['batch'],
    optional: ['step'],
    schema: ResumeCommand,
    handler: async (input, context) => context.resume(input),
  }),
  define({
    name: 'retry',
    summary: 'Give the step a Stuck batch stopped at another attempt',
    changesState: true,
    positionals: ['batch'],
    schema: RetryCommand,
    handler: async ({ batch }, context) =>
      changeBrewery('retry', context, (_state, issued) => ({ kind: 'retry', ...issued(batch) })),
  }),
  define({
    name: 'skip',
    summary: 'Go on after the step a Stuck batch stopped at',
    changesState: true,
    positionals: ['batch'],
    schema: SkipCommand,
    handler: async ({ batch }, context) =>
      changeBrewery('skip', context, (_state, issued) => ({ kind: 'skip', ...issued(batch) })),
  }),
  define({
    name: 'answer',
    summary: "Answer a Stuck batch's questions, one answer each, in order",
    changesState: true,
    positionals: ['batch'],
    rest: 'answers',
    schema: AnswerCommand,
    handler: async ({ batch, answers }, context) =>
      changeBrewery('answer', context, (state, issued) => {
        const asked = questionsOf(state(), batch);
        // A batch that asks nothing is decide's to refuse, with its reason.
        if (asked.length > 0 && answers.length !== asked.length) {
          const questions = asked.length === 1 ? '1 question' : `${asked.length} questions`;
          return {
            refused: `batch ${batch} asked ${questions}; give one answer to each, in order`,
          };
        }
        return {
          kind: 'answer',
          ...issued(batch),
          answers: asked.map((q, i) => ({ q, answer: answers[i] ?? '' })),
        };
      }),
  }),
  define({
    name: 'recipe',
    summary: 'Brew a batch with another recipe, from its first step',
    changesState: true,
    positionals: ['batch', 'recipe', 'reason'],
    schema: RecipeCommand,
    handler: async ({ batch, recipe, reason }, context) =>
      changeBrewery('recipe', context, (_state, issued) => ({
        kind: 'recipe',
        ...issued(batch),
        recipe,
        reason,
      })),
  }),
  define({
    name: 'rewind',
    summary: 'Take a Stuck batch back to a step, each repository at its commit',
    changesState: true,
    positionals: ['batch', 'step'],
    rest: 'commits',
    schema: RewindCommand,
    handler: async ({ batch, step, commits }, context) =>
      changeBrewery('rewind', context, (_state, issued) => ({
        kind: 'rewind',
        ...issued(batch),
        toStepId: step,
        shas: Object.fromEntries(commits),
      })),
  }),
  define({
    name: 'cancel',
    summary: 'Cancel a batch',
    changesState: true,
    positionals: ['batch'],
    schema: CancelCommand,
    handler: async ({ batch }, context) =>
      changeBrewery('cancel', context, (_state, issued) => ({ kind: 'cancel', ...issued(batch) })),
  }),
  define({
    name: 'order',
    summary: 'Order an issue again: <alias>#<n> of a target repository, #<n> of the Brewery',
    changesState: true,
    positionals: ['issue'],
    schema: OrderCommand,
    handler: async ({ issue: target }, context) => {
      const { alias, issue } = target;
      // A Brewery issue is never claimed, so it needs neither foedrum.jsonc nor GitHub.
      const claim = alias === undefined ? undefined : claimOf(alias, context.config());
      if (claim !== undefined && 'refused' in claim) return failed('order', claim.refused);
      const order: OrderRef = claim === undefined ? { issue } : { issue, repo: claim.repo };
      return changeBrewery('order', context, (state, issued) =>
        orderIssue(state, order, claim, {
          // Called only for a claim, which carries its config.
          claims: () => context.claims(claim?.config ?? context.config()),
          now: context.now(),
          issued,
        }),
      );
    },
  }),
  define({
    name: 'brew',
    summary: "Brew an issue's batch here until it is on tap, Stuck or needs input",
    changesState: true,
    positionals: ['issue'],
    options: { as: 'name' },
    flags: ['take'],
    schema: BrewCommand,
    // A driver of its own on the machine, run by the terminal (ADR 0123).
    handler: async (input, context) =>
      context.brew(input, { by: context.user(), via: context.surface }),
  }),
  define({
    name: 'takeover',
    summary: 'Hand a batch from the driver that holds it to another: --as, else this session',
    changesState: true,
    positionals: ['batch'],
    options: { as: 'name' },
    schema: TakeoverCommand,
    // The lease goes to the new owner at once; its driver renews it from its next tick (ADR 0124).
    handler: async ({ batch, as }, context) => {
      const owner = brewOwner(as, context.env);
      if ('refused' in owner) {
        return { exitCode: 2, stdout: '', stderr: `foedrum takeover: ${owner.refused}\n` };
      }
      return writeBrewery('takeover', context, async (log) => {
        const request = {
          batchId: batch,
          owner: owner.owner,
          by: context.user(),
          via: context.surface,
          now: context.now(),
          leaseMs: defaultLeaseMs,
        };
        const decision = takeOver(log, request);
        if (decision.kind === 'refused') return failed('takeover', decision.reason);
        const [handed] = decision.events;
        if (handed?.type !== 'batch.taken_over') throw new Error('A takeover recorded no handover');
        const { from, to, until } = handed;
        return done(`${batch} handed from ${from} to ${to}; its effects wait until ${until}\n`);
      });
    },
  }),
];
