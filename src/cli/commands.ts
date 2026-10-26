// The command registry (ADR 0019): one schema and one handler per command. Surfaces turn their
// input into a command's input and run it; run.ts is the terminal's. doctor, status, stuck,
// brewers and replay only read, and init writes only the Brewery's files, so they append nothing
// (ADR 0030, ADR 0199). The others turn their input into one of the engine's human commands and
// append its events through the command log, recorded with who issued it and from where
// (ADR 0025).

import { join } from 'node:path';
import { nextBatchId, targetBatchId } from '../engine/batch-id.ts';
import { defaultLeaseMs, takeOver } from '../engine/batch-leases.ts';
import { type CommandLog, createCommandLog } from '../engine/command-log.ts';
import { type HumanCommand, orderRefusal } from '../engine/decide.ts';
import type { EventStore, StoredEvent } from '../engine/event-store.ts';
import {
  type Batch,
  emptyState,
  fold,
  InvalidLogError,
  orderKey,
  type Rank,
  type State,
} from '../engine/fold.ts';
import {
  intakeQueue,
  intakeRepositories,
  type Listing,
  type QueuedIssue,
} from '../engine/intake.ts';
import { type ClaimHost, claimIssue } from '../engine/issue-claims.ts';
import { orderOfBatch, pauseOf, stopAtText } from '../engine/pauses.ts';
import { placeAt, rankQueue, rankRefusal } from '../engine/ranks.ts';
import { batchOf } from '../engine/state-branch.ts';
import { worktreeClaims } from '../engine/worktree-claims.ts';
import type { BreweryConfig } from '../schemas/brewery-config.ts';
import {
  AnswerCommand,
  BrewCommand,
  BrewersCommand,
  CancelCommand,
  CELLAR_OWNER,
  ContinueCommand,
  DoctorCommand,
  InitCommand,
  OrderCommand,
  type OrderTarget,
  PauseCommand,
  RankCommand,
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
import type { Event, OrderRef, Surface } from '../schemas/events.ts';
import type { z } from '../schemas/zod.ts';
import { brewerReport, formatBrewerReport, recipesRun } from './brewer-report.ts';
import { diagnose, formatDiagnosis } from './doctor.ts';
import { brewOwner } from './driver-owner.ts';
import { keptBranchLines } from './kept-branches.ts';
import { stopInstant } from './pause-time.ts';
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
export const storePath = (root: string): string => join(root, '.foedrum', 'index.db');

const done = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: '' });

const failed = (command: string, message: string): CliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `foedrum ${command}: ${message}\n`,
});

// Reads every event of the Brewery's store and folds them; one line when there is no store (or
// `none`, for a command that has an answer without one) or the fold refuses the log. Never writes
// (ADR 0030). The store closes once `show` is done.
const readBrewery = async (
  command: string,
  { cwd, openStore }: CliContext,
  show: (
    events: readonly StoredEvent[],
    state: State,
    store: EventStore,
  ) => CliResult | Promise<CliResult>,
  none?: CliResult,
): Promise<CliResult> => {
  const path = storePath(cwd);
  const store = openStore(path);
  if (store === undefined) return none ?? failed(command, `no event store at ${path}`);
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

/** An order as a person wrote it: `<alias>#<n>` or `#<n>`. */
const givenName = ({ alias, issue }: OrderTarget): string => `${alias ?? ''}#${issue}`;

/**
 * The order `target` names: a Brewery issue, or a target repository's by its alias in
 * foedrum.jsonc (ADR 0202).
 */
const orderRefOf = (target: OrderTarget, context: CliContext): OrderRef | { refused: string } => {
  const { alias, issue } = target;
  if (alias === undefined) return { issue };
  const found = Object.entries(context.config().repositories).find(
    ([, repository]) => repository.alias === alias,
  );
  if (found === undefined) {
    return { refused: `foedrum.jsonc names no repository with the alias ${alias}` };
  }
  return { issue, repo: found[0] };
};

/**
 * The intake's queue as a pass would read it now, in rank order (ADR 0208): the Brewery's open
 * issues and every intake repository's, through gh's login; or what could not be read.
 */
const readQueue = async (
  config: BreweryConfig,
  brewery: string,
  state: State,
  context: CliContext,
): Promise<QueuedIssue[] | { refused: string }> => {
  const { tracker, login } = context.queue(config);
  const read = async <T>(what: string, reading: () => Promise<T>): Promise<T> => {
    try {
      return await reading();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read the intake's queue: ${what}: ${message}`);
    }
  };
  try {
    const claimant = { brewery, login: await read('the login gh uses', () => login()) };
    const own = await read(`listing ${brewery}`, () => tracker.issues(brewery));
    const repositories: Listing[] = [];
    for (const repository of intakeRepositories(config)) {
      const { repo, filter } = repository;
      const issues = await read(`listing ${repo}`, () => tracker.issues(repo, filter));
      repositories.push({ repository, issues });
    }
    const authors = config.users ?? [];
    return intakeQueue(state, { brewery: own, repositories }, { authors, claimant });
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
};

/** How `rank` shows an order's rank, or that it has none. */
const rankText = (rank: Rank | undefined): string => {
  if (rank === undefined) return 'by its arrival';
  const { place, by, via, why } = rank;
  const what = place.kind === 'first' ? 'marked to finish first' : `ranked ${place.position}`;
  return `${what} by ${by} via ${via}${why === undefined ? '' : `: ${why}`}`;
};

/** Where `order` stands in `queue`: `place <n> of <all> in the queue`, or undefined. */
const placeIn = (queue: readonly QueuedIssue[], order: OrderRef): string | undefined => {
  const key = orderKey(order);
  const at = queue.findIndex((queued) => orderKey(queued.order) === key);
  return at < 0 ? undefined : `place ${at + 1} of ${queue.length} in the queue`;
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

/** Why a decision on a Stuck batch is the terminal's (ADR 0125). */
const STUCK_DECISION =
  "A person's decision among the options /foedrum:stuck lists, run as foedrum <option> <batch>";

export const commands: readonly RegisteredCommand[] = [
  define({
    name: 'doctor',
    summary: 'Check the tools Foedrum needs and the isolation level',
    changesState: false,
    positionals: [],
    terminalOnly: "Checks the machine's tools before Foedrum runs on it, outside any session",
    schema: DoctorCommand,
    handler: async (_input, { gatherDoctorFacts }) => {
      const diagnosis = diagnose(await gatherDoctorFacts());
      return { ...done(formatDiagnosis(diagnosis)), exitCode: diagnosis.ok ? 0 : 1 };
    },
  }),
  define({
    name: 'init',
    summary: "Write a Brewery's files in its clone from a few questions, then run doctor",
    changesState: false,
    positionals: [],
    terminalOnly:
      'Asks its questions on the terminal until /foedrum:init asks them in a session (#530)',
    schema: InitCommand,
    // Questions and lines on the terminal, run by it as brew is (ADR 0199).
    handler: async (_input, context) => context.init(),
  }),
  define({
    name: 'status',
    summary: 'List the batches and their lanes',
    changesState: false,
    positionals: [],
    flags: ['watch'],
    schema: StatusCommand,
    handler: async (input, context) => {
      // A board on the terminal, run by it as brew's live line is (ADR 0188).
      if (input.watch === true) return context.watch();
      return readBrewery(
        'status',
        context,
        async (_events, state, store) => {
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
        },
        // A fresh Brewery: serve and brew make the store when they first start.
        done('No batches yet.\n'),
      );
    },
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
    name: 'brewers',
    summary: "Report each brewer's attempts, outcomes, Stuck batches and tokens",
    changesState: false,
    positionals: [],
    schema: BrewersCommand,
    handler: async (_input, context) => {
      // Files that do not load refuse it with doctor's line, before the store is opened.
      const source = context.brewers();
      const show = (state: State, events: readonly StoredEvent[]) =>
        done(
          formatBrewerReport(
            brewerReport(state, source, recipesRun(events.map(({ event }) => event))),
          ),
        );
      // A fresh Brewery: every brewer, none with an attempt yet.
      return readBrewery(
        'brewers',
        context,
        (events, state) => show(state, events),
        show(emptyState, []),
      );
    },
  }),
  define({
    name: 'replay',
    summary: "Show a batch's events and its folded state",
    changesState: false,
    positionals: ['batch'],
    terminalOnly: "A batch's whole log, for debugging; /foedrum:status shows where each batch is",
    schema: ReplayCommand,
    handler: async ({ batch: id }, context) =>
      readBrewery('replay', context, (events, state) => {
        const batch = state.batches.get(id);
        if (batch === undefined) return failed('replay', `no batch ${id} in the event store`);
        // Beside its own events, the pauses and continues of its order or of all, which name no
        // batch (ADR 0202): since the last continue before it was ordered, so a pause that
        // held it from its order shows too.
        const ordered = events.find(({ event }) => batchOf(event) === id)?.id ?? 0;
        const order = orderKey(orderOfBatch(state, batch));
        const held = (event: Event): boolean =>
          (event.type === 'order.paused' || event.type === 'order.continued') &&
          (event.order === undefined || orderKey(event.order) === order);
        const lifted =
          events
            .filter(
              ({ id: at, event }) =>
                at < ordered && event.type === 'order.continued' && held(event),
            )
            .at(-1)?.id ?? 0;
        // And the ranks of its order, which it had in the intake's queue (ADR 0208).
        const ranked = (event: Event): boolean =>
          event.type === 'order.ranked' && orderKey(event.order) === order;
        return done(
          formatReplay(
            batch,
            events.filter(
              ({ id: at, event }) =>
                batchOf(event) === id || (at > lifted && held(event)) || ranked(event),
            ),
            pauseOf(state, batch),
          ),
        );
      }),
  }),
  define({
    name: 'resume',
    summary:
      "Open a brewer attempt's Claude Code session in its worktree; take a running batch over",
    // On a running batch it drives the batch, through serve's wiring as brew (ADR 0127).
    changesState: true,
    positionals: ['batch'],
    optional: ['step'],
    schema: ResumeCommand,
    handler: async (input, context) =>
      context.resume(input, { by: context.user(), via: context.surface }),
  }),
  define({
    name: 'retry',
    summary: 'Give the step a Stuck batch stopped at another attempt',
    changesState: true,
    positionals: ['batch'],
    terminalOnly: STUCK_DECISION,
    schema: RetryCommand,
    handler: async ({ batch }, context) =>
      changeBrewery('retry', context, (_state, issued) => ({ kind: 'retry', ...issued(batch) })),
  }),
  define({
    name: 'skip',
    summary: 'Go on after the step a Stuck batch stopped at',
    changesState: true,
    positionals: ['batch'],
    terminalOnly: STUCK_DECISION,
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
    terminalOnly: STUCK_DECISION,
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
    terminalOnly: STUCK_DECISION,
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
    terminalOnly: STUCK_DECISION,
    schema: CancelCommand,
    handler: async ({ batch }, context) =>
      changeBrewery('cancel', context, (_state, issued) => ({ kind: 'cancel', ...issued(batch) })),
  }),
  define({
    name: 'pause',
    summary: 'Pause an order, or all with --all: nothing new starts; --by stops what runs',
    changesState: true,
    positionals: [],
    optional: ['order'],
    options: { by: 'time', why: 'reason' },
    flags: ['all'],
    schema: PauseCommand,
    handler: async ({ order: target, by: time, why }, context) => {
      const order = target === undefined ? undefined : orderRefOf(target, context);
      if (order !== undefined && 'refused' in order) return failed('pause', order.refused);
      let stopAt: { at: Date; zone: string } | undefined;
      if (time !== undefined) {
        const zone = context.zone();
        const instant = stopInstant(time, context.now(), zone);
        if ('refused' in instant) return failed('pause', instant.refused);
        stopAt = { at: instant.at, zone };
      }
      return writeBrewery('pause', context, async (log) => {
        const decision = log.issue(
          {
            kind: 'pause',
            ...(order === undefined ? {} : { order }),
            by: context.user(),
            via: context.surface,
            ...(why === undefined ? {} : { why }),
            ...(stopAt === undefined ? {} : { stopAt }),
          },
          context.now(),
        );
        if (decision.kind === 'refused') return failed('pause', decision.reason);
        const held =
          target === undefined
            ? 'The Brewery is paused: nothing new starts and nothing is ordered'
            : `${givenName(target)} paused: nothing new of it starts`;
        const stopped =
          stopAt === undefined
            ? ''
            : `; what still runs at ${stopAtText({ at: stopAt.at.toISOString(), zone: stopAt.zone })} is stopped`;
        return done(`${held}, and what runs ends at its next convenient point${stopped}\n`);
      });
    },
  }),
  define({
    name: 'continue',
    summary: 'Lift the pause of an order, or every pause with --all',
    changesState: true,
    positionals: [],
    optional: ['order'],
    flags: ['all'],
    schema: ContinueCommand,
    handler: async ({ order: target }, context) => {
      const order = target === undefined ? undefined : orderRefOf(target, context);
      if (order !== undefined && 'refused' in order) return failed('continue', order.refused);
      return writeBrewery('continue', context, async (log) => {
        const decision = log.issue(
          {
            kind: 'continue',
            ...(order === undefined ? {} : { order }),
            by: context.user(),
            via: context.surface,
          },
          context.now(),
        );
        if (decision.kind === 'refused') return failed('continue', decision.reason);
        return done(
          target === undefined ? 'The Brewery continues\n' : `${givenName(target)} continues\n`,
        );
      });
    },
  }),
  define({
    name: 'order',
    summary: 'Order an issue again: <alias>#<n> of a target repository, #<n> of the Brewery',
    changesState: true,
    positionals: ['issue'],
    terminalOnly:
      "Orders an ended issue again, a person's decision (ADR 0105); /foedrum:brew orders a new one",
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
    name: 'rank',
    summary: "Move an order in the intake's queue to place <n>, or mark it to finish first",
    changesState: true,
    positionals: ['order'],
    optional: ['place'],
    options: { why: 'reason' },
    schema: RankCommand,
    // Reads the queue as a pass would, through gh's login, and records the place it finds.
    handler: async ({ order: target, place, why }, context) => {
      const order = orderRefOf(target, context);
      if ('refused' in order) return failed('rank', order.refused);
      const config = context.config();
      const { brewery } = config;
      if (brewery === undefined) return failed('rank', NAME_THE_BREWERY);
      const name = givenName(target);
      return writeBrewery('rank', context, async (log) => {
        const refusal = rankRefusal(log.state(), order);
        if (refusal !== undefined) return failed('rank', refusal);
        const queue = await readQueue(config, brewery, log.state(), context);
        if ('refused' in queue) return failed('rank', queue.refused);
        const before = placeIn(queue, order);
        if (before === undefined) {
          return failed(
            'rank',
            `${name} is not in the intake's queue: closed, filtered out, assigned to someone else or not opened by an allow-listed user`,
          );
        }
        const { ranks } = log.state();
        if (place === undefined) {
          return done(`${name}: ${before}, ${rankText(ranks.get(orderKey(order)))}\n`);
        }
        const now = context.now();
        const decision = log.issue(
          {
            kind: 'rank',
            order,
            place:
              place === 'first'
                ? { kind: 'first' }
                : {
                    kind: 'position',
                    position: place,
                    ...placeAt(queue, ranks, order, place, now),
                  },
            by: context.user(),
            via: context.surface,
            ...(why === undefined ? {} : { why }),
          },
          now,
        );
        if (decision.kind === 'refused') return failed('rank', decision.reason);
        const after = placeIn(rankQueue(queue, log.state().ranks), order);
        const ranked = place === 'first' ? 'marked to finish first' : `ranked ${place}`;
        return done(`${name} ${ranked}: ${after}\n`);
      });
    },
  }),
  define({
    name: 'takeover',
    summary: 'Hand a batch from the driver that holds it to another: --as, else this session',
    changesState: true,
    positionals: ['batch'],
    options: { as: 'name' },
    terminalOnly:
      "/foedrum:brew --take takes a batch for the session; handing one to another is the terminal's",
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
