// `foedrum brew`, the interactive driver of one batch (ADR 0123): under an owner of its own (`--as`,
// or the Claude Code session it runs in), it takes that owner's lock, opens the driver on the
// wiring it shares with `foedrum serve` (driver-wiring.ts) with `takes` that batch alone, orders and
// routes the issue first when it has no batch, and ticks until the batch is on tap, cancelled or
// Stuck. Its exit code says which, so the plugin's session can ask the engineer and brew again.

import { createCommandLog } from '../engine/command-log.ts';
import type { BatchLease } from '../engine/event-store.ts';
import type { Batch } from '../engine/fold.ts';
import { recipeLabels } from '../engine/intake.ts';
import { StateBranchStopError } from '../engine/state-branch.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { githubOrderLabels } from '../github/order-text.ts';
import type { OrderTarget } from '../schemas/commands.ts';
import type { Surface } from '../schemas/events.ts';
import { PathSafeId } from '../schemas/ids.ts';
import { type OrderClaim, orderIssue } from './commands.ts';
import { closeOpened, messageOf, type Opened, wireDriver } from './driver-wiring.ts';
import { printable } from './run.ts';
import { formatNotice, type ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';
import { describeLane } from './status.ts';

/** What `foedrum brew` brews, as whom, and who asked. */
export interface BrewRequest {
  target: OrderTarget;
  /** The driver's owner: its lock's and its leases' (ADR 0037). */
  owner: string;
  /** Who runs it, recorded on an order it makes (ADR 0105). */
  by: string;
  via: Surface;
}

/** How `foedrum brew` ends (ADR 0123); 2, a wrong command line, is the terminal's. */
export const BREW_EXIT = {
  onTap: 0,
  failed: 1,
  stuck: 3,
  needsInput: 4,
  refused: 5,
  cancelled: 6,
} as const;

/** The variable Claude Code sets to its session's id in its tools' processes. */
const SESSION = 'CLAUDE_CODE_SESSION_ID';
/** The supervisor's interval (ADR 0027), as serve's. */
const INTERVAL_MS = 5000;

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

/** The issue's latest batch: in `repo`, or a Brewery issue's when `repo` is undefined. */
const latestBatch = (
  batches: Iterable<Batch>,
  issue: number,
  repo: string | undefined,
): Batch | undefined =>
  [...batches]
    .filter(
      (batch) =>
        batch.issue === issue &&
        (repo === undefined
          ? batch.repo === undefined
          : batch.repo !== undefined && sameRepo(batch.repo, repo)),
    )
    .at(-1);

/** The lines of a batch that needs input: each question numbered as `foedrum answer` takes it. */
const questionLines = (batchId: string, stepId: string, batch: Batch): string[] => {
  const { lane } = batch;
  if (lane.kind !== 'stuck' || lane.reason.kind !== 'needs_input') return [];
  const { questions } = lane.reason;
  return [
    `batch ${batchId} needs input at ${stepId}:`,
    ...questions.flatMap(({ q, options, recommended, whyBlocking }, n) => [
      `  ${n + 1}. ${q} (${options.join(', ')}; recommended: ${recommended})`,
      `     why it blocks: ${whyBlocking}`,
    ]),
    `answer them in order with foedrum answer ${batchId} ${questions.map((_, n) => `<answer ${n + 1}>`).join(' ')}, then brew again`,
  ];
};

/** Brews the batch of `request.target` until it stops; the exit code of ADR 0123. */
export const runBrew = async (
  setup: ServeSetup,
  shell: ServeShell,
  request: BrewRequest,
): Promise<number> => {
  const { out, signal, clock, wait, intervalMs = INTERVAL_MS } = shell;
  const { target, owner, by, via } = request;
  // Notices may carry text a model wrote: never a control character on the terminal.
  const say = (line: string): void => out(printable(`foedrum brew: ${line}`));
  const refuse = (reason: string): number => {
    say(reason);
    return BREW_EXIT.refused;
  };
  // The issue's repository: a target issue's by its alias, which needs an intake (ADR 0105).
  const { alias, issue } = target;
  const repository =
    alias === undefined
      ? undefined
      : setup.intake.repositories.find((each) => each.alias === alias);
  if (alias !== undefined && repository === undefined) {
    return refuse(`foedrum.jsonc names no repository with the alias ${alias} and an intake`);
  }
  const order = repository === undefined ? { issue } : { issue, repo: repository.repo };
  // As `foedrum status` names it.
  const named = `${order.repo ?? ''}#${issue}`;
  const asGiven = `${alias ?? ''}#${issue}`;
  // The lock first: a second brew under this owner is refused before it touches anything.
  let lock: Opened['lock'];
  try {
    lock = shell.lock(setup.workRoot, { brewery: setup.brewery, owner });
  } catch (error) {
    return refuse(messageOf(error));
  }
  const opened: Opened = { lock };
  let batchId: string | undefined;
  // Another driver's lease of the batch, once this driver lost it or never got it.
  let holder: BatchLease | undefined;
  const drivenBy = (lease: BatchLease): string =>
    `batch ${lease.batchId} is driven by ${lease.owner} until ${lease.expiresAt.toISOString()}`;
  try {
    const { store, driver, reads, claims } = await wireDriver(setup, shell, opened, {
      // This batch alone, once it is known (ADR 0044).
      takes: (id) => id === batchId,
      say,
      report: (notice) => {
        if (notice.kind === 'batch_lost' && notice.batchId === batchId) holder = notice.holder;
        say(formatNotice(notice));
      },
    });
    const log = createCommandLog({ store, recipes: setup.recipes });
    const heldElsewhere = (id: string): BatchLease | undefined =>
      store.batchLeases(clock()).find((lease) => lease.batchId === id && lease.owner !== owner);

    const latest = latestBatch(log.state().batches.values(), issue, order.repo);
    if (
      latest !== undefined &&
      (latest.lane.kind === 'on_tap' || latest.lane.kind === 'cancelled')
    ) {
      const { lane } = describeLane(latest);
      return refuse(
        `batch ${latest.id} of ${named} is ${lane}; foedrum order ${asGiven} orders it again`,
      );
    }
    const leased = latest === undefined ? undefined : heldElsewhere(latest.id);
    if (leased !== undefined) return refuse(drivenBy(leased));
    // An issue with no batch, or an Ordered one, is routed by its one recipe label (ADR 0068).
    let recipe: string | undefined;
    if (latest === undefined || latest.lane.kind === 'ordered') {
      const names = recipeLabels(await githubOrderLabels(reads, setup.brewery)(order, signal));
      if (names.length === 0) {
        return refuse(
          `${named} has no recipe:<name> label; label it with the recipe to brew it with`,
        );
      }
      if (names.length > 1) {
        const all = names.map((name) => `recipe:${name}`).join(' and ');
        return refuse(`${named} carries ${all}; give it one recipe label`);
      }
      recipe = names[0];
    }
    if (latest === undefined) {
      const claim: OrderClaim | undefined =
        repository === undefined
          ? undefined
          : { repo: repository.repo, alias: repository.alias, brewery: setup.brewery };
      const command = await orderIssue(log.state, order, claim, {
        claims: () => claims,
        now: clock(),
        issued: (id) => ({ batchId: id, by, via }),
      });
      if ('refused' in command) return refuse(command.refused);
      const decision = log.issue(command, clock());
      if (decision.kind === 'refused') return refuse(decision.reason);
      say(`ordered ${named} as batch ${command.batchId}`);
    }
    const batch = latestBatch(log.state().batches.values(), issue, order.repo);
    if (batch === undefined) throw new Error(`${named} has no batch after its order`);
    batchId = batch.id;
    if (recipe !== undefined && batch.lane.kind === 'ordered') {
      const route = {
        kind: 'route',
        batchId,
        recipe,
        reason: `the label recipe:${recipe}`,
        source: 'label',
      } as const;
      const decision = log.issue(route, clock());
      if (decision.kind === 'refused') return refuse(decision.reason);
      say(`routed batch ${batchId} to the recipe ${recipe}`);
    }
    say(`brewing batch ${batchId} as ${owner}`);

    let shown = '';
    for (;;) {
      try {
        await driver.tick();
      } catch (error) {
        if (error instanceof StateBranchStopError) throw error;
        say(formatNotice({ kind: 'tick_failed', error }));
      }
      const other = holder ?? heldElsewhere(batchId);
      if (other !== undefined) return refuse(drivenBy(other));
      const now = driver.state().batches.get(batchId) as Batch;
      const { lane, detail } = describeLane(now);
      // Let go: every effect of the ended batch is applied (ADR 0044).
      const released = !driver.held().includes(batchId);
      switch (now.lane.kind) {
        case 'on_tap':
          if (!released) break;
          say(`batch ${batchId} is on tap: ${now.lane.pullRequests.join(' ')}`);
          return BREW_EXIT.onTap;
        case 'cancelled':
          if (!released) break;
          say(`batch ${batchId} was ${lane} ${detail}`);
          return BREW_EXIT.cancelled;
        case 'stuck': {
          const { reason, options } = now.lane;
          if (reason.kind === 'needs_input') {
            for (const line of questionLines(batchId, reason.stepId, now)) say(line);
            return BREW_EXIT.needsInput;
          }
          say(`batch ${batchId} is stuck: ${detail}; options: ${options.join(', ')}`);
          return BREW_EXIT.stuck;
        }
        case 'ordered':
        case 'brewing':
        case 'conditioning':
          break;
        default: {
          const unknown: never = now.lane;
          throw new Error(`Unknown lane ${JSON.stringify(unknown)}`);
        }
      }
      const line = `batch ${batchId} ${lane}${detail === '' ? '' : `: ${detail}`}`;
      if (line !== shown) {
        shown = line;
        say(line);
      }
      if (signal.aborted) break;
      await wait(intervalMs, signal);
      if (signal.aborted) break;
    }
    say(`stopped; ${shown}`);
    return BREW_EXIT.failed;
  } catch (error) {
    // A call the stop itself ended, such as gh reading the login at the start, is a stop.
    if (signal.aborted && error === signal.reason) {
      say('stopped');
      return BREW_EXIT.failed;
    }
    say(messageOf(error));
    return BREW_EXIT.failed;
  } finally {
    // Closing the driver stops its runs and lets the lock go; a Stuck batch keeps its lease.
    closeOpened(opened);
  }
};
