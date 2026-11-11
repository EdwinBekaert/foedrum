// The command registry (ADR 0019): one schema and one handler per command. Surfaces turn their
// input into a command's input and run it; run.ts is the terminal's. doctor, status, stuck,
// brewers, lenses and replay only read, and init writes only the Brewery's files, so they append nothing
// (ADR 0030, ADR 0199). The others turn their input into one of the engine's human commands and
// append its events through the command log, recorded with who issued it and from where
// (ADR 0025).

import { nextBatchId, targetBatchId } from '../engine/batch-id.ts';
import { defaultLeaseMs, takeOver } from '../engine/batch-leases.ts';
import { stateClause, stateOf } from '../engine/batch-state.ts';
import {
  calledAs,
  latestBatch,
  type NamedWork,
  namedWork,
  saidAs,
} from '../engine/claim-orders.ts';
import { type CommandLog, createCommandLog } from '../engine/command-log.ts';
import { type HumanCommand, orderRefusal } from '../engine/decide.ts';
import type { EventStore, StoredEvent } from '../engine/event-store.ts';
import {
  emptyState,
  fold,
  foldedBatch,
  InvalidLogError,
  orderKey,
  type Rank,
  type State,
} from '../engine/fold.ts';
import { type Handover, handoverLines, handoversOf } from '../engine/handover.ts';
import {
  intakeQueue,
  intakeRepositories,
  type Listing,
  type QueuedIssue,
  withLabelsAdded,
} from '../engine/intake.ts';
import { type ClaimHost, claimIssue, same, unapprovedLabels } from '../engine/issue-claims.ts';
import {
  DEFAULT_OPEN_ORDERS,
  type Limits,
  limitLines,
  limitsOf,
  mayHold,
} from '../engine/limits.ts';
import { stuckNext } from '../engine/next-step.ts';
import { ORDER_CHANGED_QUESTION } from '../engine/order-changes.ts';
import { orderOfBatch, pauseOf, stopAtText } from '../engine/pauses.ts';
import { onePerOrder, placeAt, rankQueue, rankRefusal } from '../engine/ranks.ts';
import { batchOf } from '../engine/state-branch.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { scopeOf } from '../engine/usage-window.ts';
import { worktreeClaims } from '../engine/worktree-claims.ts';
import { firstLineOf, messageOf } from '../platform/errors.ts';
import type { BreweryConfig } from '../schemas/brewery-config.ts';
import {
  AnswerCommand,
  ApproveCommand,
  type BatchOrIssue,
  BrewCommand,
  BrewersCommand,
  CancelCommand,
  CELLAR_OWNER,
  ContinueCommand,
  DoctorCommand,
  HandoverCommand,
  InitCommand,
  LauterCommand,
  LensesCommand,
  MashCommand,
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
  StopCommand,
  StuckCommand,
  TakeoverCommand,
} from '../schemas/commands.ts';
import type { Event, OrderRef, Surface, UsageScope } from '../schemas/events.ts';
import type { z } from '../schemas/zod.ts';
import { brewerReport, formatBrewerReport, recipesRun } from './brewer-report.ts';
import { diagnose, formatDiagnosis } from './doctor.ts';
import { brewOwner } from './driver-owner.ts';
import { keptBranchLines } from './kept-branches.ts';
import { formatLensReport, lensReport } from './lens-report.ts';
import { stopInstant } from './pause-time.ts';
import { formatReplay } from './replay.ts';
import type { CliContext, CliResult } from './run.ts';
import { NAME_THE_BREWERY, storePath } from './serve-config.ts';
import {
  describeState,
  formatOrderStatus,
  formatStatus,
  orderBatches,
  withDetail,
} from './status.ts';
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
  /** The options that may be given more than once, their field a list of the values in order. */
  repeated?: readonly string[];
  /** The options it takes without a value, each a field of its own that is true when given. */
  flags?: readonly string[];
  /** What `--help`'s row shows for its options and flags, which it then lists below the table. */
  synopsis?: string;
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
  repeated?: readonly string[];
  flags?: readonly string[];
  synopsis?: string;
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

const done = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: '' });

const failed = (command: string, message: string): CliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `foedrum ${command}: ${message}\n`,
});

/**
 * The lines of the limits that hold now (ADR 0217), from foedrum.jsonc and the recipes, read only
 * while a limit can hold; one line when they do not load.
 */
const limitsHeld = (state: State, { config, recipes }: CliContext): string[] => {
  if (!mayHold(state)) return [];
  let limits: Limits;
  try {
    limits = limitsOf(config().openOrders ?? DEFAULT_OPEN_ORDERS, recipes());
  } catch (error) {
    const [first] = messageOf(error).split('\n');
    return [`the limits could not be read: ${first}`];
  }
  return limitLines(state, limits);
};

/** Each line by its id, `<step>#<attempt>.<line>`, under a head that says who wrote them. */
export const formatHandovers = (batchId: string, handovers: readonly Handover[]): string => {
  if (handovers.length === 0) return `${batchId}: no handover lines\n`;
  const lines = new Map<string, number>();
  return [
    `${batchId}: ${handoverLines(handovers.length)} a model wrote, to read as data.\n`,
    ...handovers.map(({ stepId, attempt, text }) => {
      const at = `${stepId}#${attempt}`;
      const line = (lines.get(at) ?? 0) + 1;
      lines.set(at, line);
      return `${at}.${line}: ${text}\n`;
    }),
  ].join('');
};

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

/** The command's user and surface, as the issuer of a human command. */
const issuedBy =
  ({ user, surface }: CliContext): Issued =>
  (batchId) => ({ batchId, by: user(), via: surface });

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
    const human = await build(() => log.state(), issuedBy(context));
    if ('refused' in human) return failed(command, human.refused);
    let decision: ReturnType<CommandLog['issue']>;
    try {
      decision = log.issue(human, context.now());
    } catch (error) {
      if (error instanceof InvalidLogError) throw error;
      // Its recipe, or the store: what it says cannot tell (ADR 0335). What still works reads no recipe.
      const why = `batch ${human.batchId} could not be changed: ${firstLineOf(messageOf(error))}`;
      return failed(
        command,
        `${why}; if its recipe is what failed, cancel it or choose another recipe`,
      );
    }
    if (decision.kind === 'refused') return failed(command, decision.reason);
    return done(`${laneLine(log.state(), human.batchId)}\n`);
  });

/** What the batch `batchId` is now to a person (ADR 0379), as a command that changed it says. */
const laneLine = (state: State, batchId: string): string => {
  // Accepted, so the batch exists.
  const batch = foldedBatch(state, batchId);
  const now = stateOf(state, batch);
  const { detail } = describeState(batch, now, calledAs(state, batch));
  return `${saidAs(state, batch)} is ${withDetail(stateClause(now), detail)}`;
};

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

/** What `order` and `recipe` order for an issue, how they name it, and the claim it needs. */
interface Ordering {
  order: OrderRef;
  name: string;
  claim?: OrderClaim & { config: BreweryConfig };
}

/** What `order` and `recipe` act on for the target issue `<alias>#<issue>`, claimed in its repository. */
const aliasedOrdering = (
  alias: string,
  issue: number,
  config: BreweryConfig,
): Ordering | { refused: string } => {
  const claim = claimOf(alias, config);
  if ('refused' in claim) return claim;
  return { order: { issue, repo: claim.repo }, name: `${alias}#${issue}`, claim };
};

/**
 * What `order` and `recipe` act on for the Brewery issue `#<issue>` (ADR 0240): its own batches,
 * which need no foedrum.jsonc, or, when it is the Brewery issue of a claimed order, that claimed
 * issue (ADR 0144).
 */
const breweryOrdering = (
  issue: number,
  { order }: NamedWork,
  config: () => BreweryConfig,
): Ordering | { refused: string } => {
  const name = `#${issue}`;
  const { repo } = order;
  if (repo === undefined) return { order: { issue }, name };
  // The alias foedrum.jsonc gives the repository now: one in the batch's id may have been renamed.
  const alias = Object.entries(config().repositories).find(([each]) => sameRepo(each, repo))?.[1]
    .alias;
  if (alias === undefined) {
    return {
      refused: `foedrum.jsonc gives ${repo} no alias; give it one to order its issue again`,
    };
  }
  const claimed = aliasedOrdering(alias, order.issue, config());
  return 'refused' in claimed ? claimed : { ...claimed, name };
};

/** The repository foedrum.jsonc gives the alias, read only for a target issue's name. */
const repoOfAlias =
  ({ config }: CliContext) =>
  (alias: string): string | undefined =>
    Object.entries(config().repositories).find(([, repository]) => repository.alias === alias)?.[0];

/**
 * The ordering of `target` from the folded state: `<alias>#<n>` refused once its Brewery issue is
 * alive, and a number read as `breweryOrdering` does (ADR 0329).
 */
const orderingOf = (
  state: State,
  target: OrderTarget,
  aliased: Ordering | undefined,
  command: string,
  context: CliContext,
): Ordering | { refused: string } => {
  const work = namedWork(state, target, repoOfAlias(context), command);
  if ('refused' in work) return work;
  return aliased ?? breweryOrdering(target.issue, work, context.config);
};

/**
 * The batch a command names by `target` (ADR 0329): a batch id as it is, which decide refuses when
 * it is none, and an issue's latest batch.
 */
const batchNamed = (
  state: State,
  target: BatchOrIssue,
  command: string,
  context: CliContext,
): string | { refused: string } => {
  if (typeof target === 'string') return target;
  const work = namedWork(state, target, repoOfAlias(context), command);
  if ('refused' in work) return work;
  return work.batch?.id ?? { refused: `${work.name} has no batch` };
};

/** `changeBrewery` for a command on one batch, named as `batchNamed` reads it. */
const changeBatch = (
  command: string,
  target: BatchOrIssue,
  context: CliContext,
  build: (
    batchId: string,
    issued: Issued,
    state: () => State,
  ) => HumanCommand | { refused: string },
): Promise<CliResult> =>
  changeBrewery(command, context, (state, issued) => {
    const batchId = batchNamed(state(), target, command, context);
    return typeof batchId === 'string' ? build(batchId, issued, state) : batchId;
  });

/**
 * The ordering of `target` that needs no store: a target issue's, read from foedrum.jsonc before
 * the store opens; undefined for a Brewery issue, which the folded state settles.
 */
const aliasedTarget = (
  { alias, issue }: OrderTarget,
  context: CliContext,
): Ordering | { refused: string } | undefined =>
  alias === undefined ? undefined : aliasedOrdering(alias, issue, context.config());

/** An order as a person wrote it: `<alias>#<n>` or `#<n>`. */
const givenName = ({ alias, issue }: OrderTarget): string => `${alias ?? ''}#${issue}`;

/**
 * The order `target` names for `command`, as the pauses and ranks key it (ADR 0202): a Brewery
 * issue, a target repository's by its alias in foedrum.jsonc, and the claimed issue a Brewery issue
 * is the order of (ADR 0329).
 */
const orderNamed = (
  state: State,
  target: OrderTarget,
  command: string,
  context: CliContext,
): OrderRef | { refused: string } => {
  const work = namedWork(state, target, repoOfAlias(context), command);
  return 'refused' in work ? work : work.order;
};

/** The batches an interactive driver holds now, by its owner (ADR 0123). */
const interactiveOwners = (store: EventStore, { now }: CliContext): Map<string, string> =>
  new Map(
    store
      .batchLeases(now())
      .filter(({ owner }) => owner !== CELLAR_OWNER)
      .map(({ batchId, owner }) => [batchId, owner]),
  );

/**
 * What `foedrum status <order>` prints: the order's batches and its sub-orders', and what its
 * planning and its brewing took (ADR 0295).
 */
const orderStatus = async (target: OrderTarget, context: CliContext): Promise<CliResult> => {
  const none = failed('status', `no batch brews ${givenName(target)}`);
  return readBrewery(
    'status',
    context,
    (_events, state, store) => {
      const order = orderNamed(state, target, 'status', context);
      if ('refused' in order) return failed('status', order.refused);
      // By its number: only the batches whose order that number is (`orderBatches`).
      const batches = orderBatches(
        state,
        target.alias === undefined ? { issue: target.issue } : order,
      );
      if (batches.length === 0) return none;
      return done(formatOrderStatus(state, batches, interactiveOwners(store, context)));
    },
    none,
  );
};

/**
 * The intake's queue as a pass would read it now, in rank order (ADR 0208): the Brewery's open
 * issues and every intake repository's, through gh's login, with who added each candidate's labels
 * (ADR 0359); or what could not be read. `placed`, the order being ranked, is in it while
 * sub-orders of it are left, ready or not (ADR 0211). `why`: why an order is not in it. `unread`:
 * why the labels of an order could not be read; the queue leaves it out, as a pass does.
 */
const readQueue = async (
  config: BreweryConfig,
  brewery: string,
  state: State,
  context: CliContext,
  placed: OrderRef,
): Promise<
  | {
      queue: QueuedIssue[];
      why: (order: OrderRef) => string;
      unread: (order: OrderRef) => string | undefined;
    }
  | { refused: string }
> => {
  const { tracker, login } = context.queue(config);
  const read = async <T>(what: string, reading: () => Promise<T>): Promise<T> => {
    try {
      return await reading();
    } catch (error) {
      const message = messageOf(error);
      throw new Error(`cannot read the intake's queue: ${what}: ${message}`);
    }
  };
  try {
    const claimant = { brewery, login: await read('the login gh uses', () => login()) };
    const own = await read(`listing ${brewery}`, () => tracker.issues(brewery));
    const listings: Listing[] = [];
    for (const repository of intakeRepositories(config)) {
      const { repo, filter } = repository;
      const issues = await read(`listing ${repo}`, () => tracker.issues(repo, filter));
      listings.push({ repository, issues });
    }
    // By `<repo>#<n>`: rank names a target issue by its alias, so its repository is foedrum.jsonc's,
    // as the listing's is.
    const failures = new Map<string, string>();
    const failed = (issue: string, error: unknown): void => {
      failures.set(issue, messageOf(error));
    };
    const repositories = await withLabelsAdded(state, listings, { claimant, tracker, failed });
    const authors = config.users ?? [];
    const queue = intakeQueue(state, { brewery: own, repositories }, { authors, claimant }, placed);
    return {
      queue,
      why: (order) => notQueued(repositories, authors, order),
      unread: ({ repo, issue }) =>
        repo === undefined ? undefined : failures.get(`${repo}#${issue}`),
    };
  } catch (error) {
    return { refused: messageOf(error) };
  }
};

/**
 * Why `order` is not in the queue read from `repositories`: who added the labels of a target issue
 * that passes every other check (ADR 0359), or what else keeps an issue out.
 */
const notQueued = (
  repositories: readonly Listing[],
  users: readonly string[],
  order: OrderRef,
): string => {
  const { repo } = order;
  const listing = repositories.find(
    ({ repository }) => repo !== undefined && same(repository.repo, repo),
  );
  // Only an issue that passes every other check has its addings read.
  const read = listing?.issues.find(
    ({ number, labelsAdded }) => number === order.issue && labelsAdded !== undefined,
  );
  const why =
    listing === undefined || read === undefined
      ? undefined
      : unapprovedLabels(read, listing.repository.filter, users);
  return (
    why ??
    'closed, filtered out, assigned to someone else or, for a Brewery issue, not opened by someone in users'
  );
};

/** How `rank` shows an order's rank, or that it has none. */
const rankText = (rank: Rank | undefined): string => {
  if (rank === undefined) return 'by its arrival';
  const { place, by, via, why } = rank;
  const what = place.kind === 'first' ? 'marked to finish first' : `ranked ${place.position}`;
  return `${what} by ${by} via ${via}${why === undefined ? '' : `: ${why}`}`;
};

/**
 * Where `order` stands in `queue`: `place <n> of <all> in the queue`, or undefined. An order's
 * ready sub-orders hold one place (ADR 0211).
 */
const placeIn = (queue: readonly QueuedIssue[], order: OrderRef): string | undefined => {
  const key = orderKey(order);
  const orders = onePerOrder(queue);
  const at = orders.findIndex((queued) => orderKey(queued.order) === key);
  return at < 0 ? undefined : `place ${at + 1} of ${orders.length} in the queue`;
};

/**
 * The questions `batch` asks while Stuck on `needs_input`, in order, or the one a batch whose issue
 * changed asks (ADR 0368); none otherwise.
 */
const questionsOf = (state: State, batchId: string): readonly string[] => {
  const lane = state.batches.get(batchId)?.lane;
  if (lane?.kind !== 'stuck') return [];
  if (lane.reason.kind === 'order_changed') return [ORDER_CHANGED_QUESTION];
  return lane.reason.kind === 'needs_input' ? lane.reason.questions.map(({ q }) => q) : [];
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
  "A person's decision among the options /foedrum:stuck lists, run as foedrum <option> <issue>, or by the id its run as: line gives";

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
    summary:
      'Set up a Brewery from a few questions, each answerable by its option, then run doctor',
    changesState: false,
    positionals: [],
    // Each the answer to one question, as typed (ADR 0212).
    options: {
      brewery: 'owner/name',
      visibility: 'private|public',
      targets: 'owner/name ...',
      alias: 'repo=alias',
      'use-checks': 'repo=y|n',
      check: 'repo:check=command',
      change: 'file=y|n',
      label: 'repo=y|n',
      push: 'y|n',
      shim: 'n|number',
      repoint: 'y|n',
    },
    repeated: ['alias', 'use-checks', 'check', 'change', 'label'],
    flags: ['no-input'],
    synopsis: '[--<question> <answer>]... [--no-input]',
    schema: InitCommand,
    // Questions and lines on the terminal, run by it as brew is (ADR 0199).
    handler: async (input, context) => context.init(input),
  }),
  define({
    name: 'status',
    summary:
      "List the batches and what each is, or an order's with its planning and brewing tokens",
    changesState: false,
    positionals: [],
    optional: ['order'],
    flags: ['watch'],
    schema: StatusCommand,
    handler: async (input, context) => {
      if (input.order !== undefined) {
        if (input.watch === true) {
          return failed('status', '--watch shows every batch; give it without an order');
        }
        return orderStatus(input.order, context);
      }
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
          const kept = keptBranchLines(unpushed, readings);
          const interactive = interactiveOwners(store, context);
          return done(formatStatus(state, kept, interactive, limitsHeld(state, context)));
        },
        // A fresh Brewery: serve and brew make the store when they first start.
        done('No batches yet.\n'),
      );
    },
  }),
  define({
    name: 'stuck',
    summary: 'List the batches that wait for you, with their questions and what to do next',
    changesState: false,
    positionals: [],
    schema: StuckCommand,
    handler: async (_input, context) =>
      readBrewery('stuck', context, (_events, state) => done(formatStuck(state))),
  }),
  define({
    name: 'brewers',
    summary: "Report each brewer's attempts, outcomes, the batches waiting for you and tokens",
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
    name: 'lenses',
    summary: "Report each lens's findings, how they ended, and its tokens",
    changesState: false,
    positionals: [],
    schema: LensesCommand,
    handler: async (_input, context) => {
      // Files that do not load refuse it with doctor's line, before the store is opened.
      const source = context.lenses();
      const show = (state: State, events: readonly StoredEvent[]) =>
        done(
          formatLensReport(lensReport(state, source, recipesRun(events.map(({ event }) => event)))),
        );
      // A fresh Brewery: every lens, none with a round yet.
      return readBrewery(
        'lenses',
        context,
        (events, state) => show(state, events),
        show(emptyState, []),
      );
    },
  }),
  define({
    name: 'handover',
    summary: "List what a batch's brewers handed over, each line a proposal a model wrote",
    changesState: false,
    positionals: ['issue'],
    schema: HandoverCommand,
    handler: async ({ issue }, context) =>
      readBrewery('handover', context, (_events, state) => {
        const id = batchNamed(state, issue, 'handover', context);
        if (typeof id !== 'string') return failed('handover', id.refused);
        const batch = state.batches.get(id);
        if (batch === undefined) return failed('handover', `no batch ${id} in the event store`);
        return done(formatHandovers(id, handoversOf(batch)));
      }),
  }),
  define({
    name: 'replay',
    summary: "Show a batch's events and its folded state",
    changesState: false,
    positionals: ['issue'],
    terminalOnly: "A batch's whole log, for debugging; /foedrum:status shows where each batch is",
    schema: ReplayCommand,
    handler: async ({ issue }, context) =>
      readBrewery('replay', context, (events, state) => {
        const id = batchNamed(state, issue, 'replay', context);
        if (typeof id !== 'string') return failed('replay', id.refused);
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
        // And the usage windows, which hold the brewers of every batch, since every one was last
        // open before the batch was ordered (ADR 0206, ADR 0215).
        const windowed = (event: Event): boolean =>
          event.type === 'usage.window_closed' || event.type === 'usage.window_opened';
        const closed = new Set<UsageScope>();
        let opened = 0;
        for (const { id: at, event } of events) {
          if (at >= ordered) break;
          if (event.type === 'usage.window_closed') closed.add(scopeOf(event.limit));
          if (event.type !== 'usage.window_opened') continue;
          // Without a scope, as #543 wrote it, every closed window opened.
          if (event.scope === undefined) closed.clear();
          else closed.delete(event.scope);
          if (closed.size === 0) opened = at;
        }
        return done(
          formatReplay(
            batch,
            events.filter(
              ({ id: at, event }) =>
                batchOf(event) === id ||
                (at > lifted && held(event)) ||
                ranked(event) ||
                (at > opened && windowed(event)),
            ),
            pauseOf(state, batch),
            calledAs(state, batch),
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
    positionals: ['issue'],
    optional: ['step'],
    schema: ResumeCommand,
    handler: async ({ issue, step }, context) => {
      const issued = { by: context.user(), via: context.surface };
      if (typeof issue === 'string') return context.resume({ batch: issue, step }, issued);
      // The store is read and closed first: the session may run for hours.
      const read = await readBrewery('resume', context, (_events, state) => {
        const batch = batchNamed(state, issue, 'resume', context);
        return typeof batch === 'string' ? done(batch) : failed('resume', batch.refused);
      });
      return read.exitCode === 0 ? context.resume({ batch: read.stdout, step }, issued) : read;
    },
  }),
  define({
    name: 'retry',
    summary: 'Try again the step a batch waiting for you stopped at',
    changesState: true,
    positionals: ['issue'],
    terminalOnly: STUCK_DECISION,
    schema: RetryCommand,
    handler: async ({ issue }, context) =>
      changeBatch('retry', issue, context, (batch, issued) => ({
        kind: 'retry',
        ...issued(batch),
      })),
  }),
  define({
    name: 'skip',
    summary: 'Go past the step a batch waiting for you stopped at',
    changesState: true,
    positionals: ['issue'],
    terminalOnly: STUCK_DECISION,
    schema: SkipCommand,
    handler: async ({ issue }, context) =>
      changeBatch('skip', issue, context, (batch, issued) => ({ kind: 'skip', ...issued(batch) })),
  }),
  define({
    name: 'answer',
    summary: 'Answer the questions a batch waits for, one answer each, in order',
    changesState: true,
    positionals: ['issue'],
    rest: 'answers',
    schema: AnswerCommand,
    handler: async ({ issue, answers }, context) =>
      changeBatch('answer', issue, context, (batch, issued, state) => {
        const asked = questionsOf(state(), batch);
        // A batch that asks nothing is decide's to refuse, with its reason.
        if (asked.length > 0 && answers.length !== asked.length) {
          const questions = asked.length === 1 ? '1 question' : `${asked.length} questions`;
          return {
            refused: `${saidAs(state(), foldedBatch(state(), batch))} asked ${questions}; give one answer to each, in order`,
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
    name: 'approve',
    summary: 'Approve the plan a batch waits for you to review; its sub-orders are opened',
    changesState: true,
    positionals: ['issue'],
    schema: ApproveCommand,
    handler: async ({ issue }, context) =>
      changeBatch('approve', issue, context, (batch, issued) => ({
        kind: 'approve',
        ...issued(batch),
      })),
  }),
  define({
    name: 'lauter',
    summary: 'Correct the plan a batch waits for you to review, with the Brewmaster in a session',
    changesState: true,
    positionals: ['issue'],
    options: { as: 'name' },
    schema: LauterCommand,
    // brew's driver, the lauter recorded at its start, until the session's plan waits (ADR 0286).
    handler: async (input, context) =>
      context.brew(input, { by: context.user(), via: context.surface }),
  }),
  define({
    name: 'recipe',
    summary:
      "Brew a batch, or an issue's latest, with another recipe from its first step; an ended issue is ordered again",
    changesState: true,
    positionals: ['target', 'recipe', 'reason'],
    schema: RecipeCommand,
    handler: async ({ target, recipe, reason }, context) => {
      // The batch a person chose the recipe of: its effects are applied once the store is closed,
      // so its recipe label and its status comment show before the command returns (ADR 0355).
      let chosen: string | undefined;
      const choose = async (): Promise<CliResult> => {
        if (typeof target === 'string') {
          const result = await changeBrewery('recipe', context, (_state, issued) => ({
            kind: 'recipe',
            ...issued(target),
            recipe,
            reason,
          }));
          if (result.exitCode === 0) chosen = target;
          return result;
        }
        const aliased = aliasedTarget(target, context);
        if (aliased !== undefined && 'refused' in aliased) return failed('recipe', aliased.refused);
        return writeBrewery('recipe', context, async (log) => {
          const { now } = context;
          const issued = issuedBy(context);
          // Before anything is ordered or claimed; decide checks it again.
          if (context.recipes().find(recipe) === undefined) {
            return failed('recipe', `the Brewery has no recipe ${recipe}`);
          }
          const ordering = orderingOf(log.state(), target, aliased, 'recipe', context);
          if ('refused' in ordering) return failed('recipe', ordering.refused);
          const { order, name, claim } = ordering;
          const latest = latestBatch(log.state().batches.values(), order.issue, order.repo);
          // Killing a running attempt stays a person's explicit stop (ADR 0205).
          if (latest?.lane.kind === 'brewing') {
            return failed(
              'recipe',
              `${name} is running; foedrum stop ${name.replace(/^#/, '')} first, then change its recipe`,
            );
          }
          const lines: string[] = [];
          let batchId: string;
          if (
            latest === undefined ||
            latest.lane.kind === 'on_tap' ||
            latest.lane.kind === 'cancelled'
          ) {
            const ordered = await orderIssue(log.state, order, claim, {
              // Called only for a claim, which carries its config.
              claims: () => context.claims(claim?.config ?? context.config()),
              now: now(),
              issued,
            });
            if ('refused' in ordered) return failed('recipe', ordered.refused);
            const decision = log.issue(ordered, now());
            if (decision.kind === 'refused') return failed('recipe', decision.reason);
            batchId = ordered.batchId;
            lines.push(`ordered ${name}`);
          } else {
            batchId = latest.id;
          }
          const decision = log.issue({ kind: 'recipe', ...issued(batchId), recipe, reason }, now());
          // A batch ordered in the transaction before stays, as when the intake routed it between.
          if (decision.kind === 'refused') {
            const refused = failed('recipe', decision.reason);
            return lines.length === 0 ? refused : { ...refused, stdout: `${lines.join('\n')}\n` };
          }
          lines.push(laneLine(log.state(), batchId));
          chosen = batchId;
          return done(`${lines.join('\n')}\n`);
        });
      };
      const result = await choose();
      if (chosen === undefined) return result;
      const said = await context.applyEffects(chosen);
      const more = said.map((line) => `${line}\n`).join('');
      return { ...result, stdout: `${result.stdout}${more}` };
    },
  }),
  define({
    name: 'rewind',
    summary: 'Take a batch waiting for you back to a step, each repository at its commit',
    changesState: true,
    positionals: ['issue', 'step'],
    rest: 'commits',
    terminalOnly: STUCK_DECISION,
    schema: RewindCommand,
    handler: async ({ issue, step, commits }, context) =>
      changeBatch('rewind', issue, context, (batch, issued) => ({
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
    positionals: ['issue'],
    terminalOnly: STUCK_DECISION,
    schema: CancelCommand,
    handler: async ({ issue }, context) =>
      changeBatch('cancel', issue, context, (batch, issued) => ({
        kind: 'cancel',
        ...issued(batch),
      })),
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
      let stopAt: { at: Date; zone: string } | undefined;
      if (time !== undefined) {
        const zone = context.zone();
        const instant = stopInstant(time, context.now(), zone);
        if ('refused' in instant) return failed('pause', instant.refused);
        stopAt = { at: instant.at, zone };
      }
      return writeBrewery('pause', context, async (log) => {
        const order =
          target === undefined ? undefined : orderNamed(log.state(), target, 'pause', context);
        if (order !== undefined && 'refused' in order) return failed('pause', order.refused);
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
      return writeBrewery('continue', context, async (log) => {
        const order =
          target === undefined ? undefined : orderNamed(log.state(), target, 'continue', context);
        if (order !== undefined && 'refused' in order) return failed('continue', order.refused);
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
    name: 'stop',
    summary:
      'Stop an order now: what runs of it is killed, and its batches wait for you until retry',
    changesState: true,
    positionals: ['order'],
    options: { why: 'reason' },
    schema: StopCommand,
    handler: async ({ order: target, why }, context) => {
      return writeBrewery('stop', context, async (log) => {
        const order = orderNamed(log.state(), target, 'stop', context);
        if ('refused' in order) return failed('stop', order.refused);
        const decision = log.issue(
          {
            kind: 'stop',
            order,
            by: context.user(),
            via: context.surface,
            ...(why === undefined ? {} : { why }),
          },
          context.now(),
        );
        if (decision.kind === 'refused') return failed('stop', decision.reason);
        const state = log.state();
        const stopped = decision.events.flatMap((event) => {
          if (event.type !== 'batch.stuck' || event.reason.kind !== 'stopped') return [];
          const batch = foldedBatch(state, event.batchId);
          return [
            `${saidAs(state, batch)} waits for you at step ${event.reason.stepId}`,
            `  ${stuckNext(event.reason, event.options, calledAs(state, batch), (text) => text)}`,
          ];
        });
        return done(`${givenName(target)} stopped.\n${stopped.join('\n')}\n`);
      });
    },
  }),
  define({
    name: 'order',
    summary:
      'Order an issue, or an ended one again: <alias>#<n> of a target repository, #<n> of the Brewery',
    changesState: true,
    positionals: ['issue'],
    schema: OrderCommand,
    handler: async ({ issue: target }, context) => {
      const aliased = aliasedTarget(target, context);
      if (aliased !== undefined && 'refused' in aliased) return failed('order', aliased.refused);
      return changeBrewery('order', context, (state, issued) => {
        // A Brewery issue's own batches need neither foedrum.jsonc nor GitHub.
        const ordering = orderingOf(state(), target, aliased, 'order', context);
        if ('refused' in ordering) return ordering;
        const { order, claim } = ordering;
        return orderIssue(state, order, claim, {
          // Called only for a claim, which carries its config.
          claims: () => context.claims(claim?.config ?? context.config()),
          now: context.now(),
          issued,
        });
      });
    },
  }),
  define({
    name: 'brew',
    summary: "Brew an issue's batch here until it is done or waits for you",
    changesState: true,
    positionals: ['issue'],
    options: { as: 'name' },
    flags: ['take', 'new-window'],
    schema: BrewCommand,
    // A driver of its own on the machine, run by the terminal (ADR 0123).
    handler: async (input, context) =>
      context.brew(input, { by: context.user(), via: context.surface }),
  }),
  define({
    name: 'mash',
    summary: 'Ask which recipe brews a Brewery issue, with a suggestion and its reason',
    changesState: true,
    positionals: ['issue'],
    options: { as: 'name' },
    flags: ['take', 'override'],
    schema: MashCommand,
    // brew's driver, routed to mash-in first, until the Innkeeper's question (ADR 0232); with
    // --override also a batch that has a recipe (ADR 0374).
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
      const config = context.config();
      const { brewery } = config;
      if (brewery === undefined) return failed('rank', NAME_THE_BREWERY);
      const name = givenName(target);
      return writeBrewery('rank', context, async (log) => {
        const order = orderNamed(log.state(), target, 'rank', context);
        if ('refused' in order) return failed('rank', order.refused);
        const refusal = rankRefusal(log.state(), order);
        if (refusal !== undefined) return failed('rank', refusal);
        const read = await readQueue(config, brewery, log.state(), context, order);
        if ('refused' in read) return failed('rank', read.refused);
        const { queue } = read;
        const unread = read.unread(order);
        if (unread !== undefined) {
          return failed('rank', `cannot read who labelled ${name}: ${unread}`);
        }
        const before = placeIn(queue, order);
        if (before === undefined) {
          return failed('rank', `${name} is not in the intake's queue: ${read.why(order)}`);
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
    summary:
      'Hand a batch from the driver that holds it to another: --as, else this session, else terminal',
    changesState: true,
    positionals: ['issue'],
    options: { as: 'name' },
    terminalOnly:
      "/foedrum:brew --take takes a batch for the session; handing one to another is the terminal's",
    schema: TakeoverCommand,
    // The lease goes to the new owner at once; its driver renews it from its next tick (ADR 0124).
    handler: async ({ issue, as }, context) => {
      const owner = brewOwner(as, context.env);
      if ('refused' in owner) {
        return { exitCode: 2, stdout: '', stderr: `foedrum takeover: ${owner.refused}\n` };
      }
      return writeBrewery('takeover', context, async (log) => {
        const batch = batchNamed(log.state(), issue, 'takeover', context);
        if (typeof batch !== 'string') return failed('takeover', batch.refused);
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
        const said = saidAs(log.state(), foldedBatch(log.state(), batch));
        return done(`${said} handed from ${from} to ${to}; its effects wait until ${until}\n`);
      });
    },
  }),
];
