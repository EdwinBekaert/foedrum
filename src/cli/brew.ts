// `foedrum brew`, the interactive driver of one batch (ADR 0123): under an owner of its own (`--as`,
// or the Claude Code session it runs in, else `terminal`), it takes that owner's lock, opens the
// driver on the wiring it shares with `foedrum serve` (driver-wiring.ts) with `takes` that batch
// alone, orders and routes the issue first when it has no batch, and ticks until the batch is on
// tap, cancelled or Stuck. Its exit code says which, so the plugin's session can ask the engineer
// and brew again.
// On a terminal (the shell gives one) it keeps a live line of what the running attempts do (ADR 0174).

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { defaultLeaseMs as leaseMs, takeOver } from '../engine/batch-leases.ts';
import { breweryIssueOf, claimOfOrder } from '../engine/claim-orders.ts';
import { createCommandLog } from '../engine/command-log.ts';
import type { DriverNotice } from '../engine/driver.ts';
import { DriverRunningError } from '../engine/driver-lock.ts';
import type { BatchLease } from '../engine/event-store.ts';
import type { Batch, State } from '../engine/fold.ts';
import { recipeLabels } from '../engine/intake.ts';
import { orderOfBatch, pauseOf } from '../engine/pauses.ts';
import { planCommentOf } from '../engine/plan-comment.ts';
import { statusCommentOf } from '../engine/status-comment.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { githubOrderLabels, type OrderIssue } from '../github/order-text.ts';
import type { OrderTarget } from '../schemas/commands.ts';
import type { Surface } from '../schemas/events.ts';
import { type OrderClaim, orderIssue } from './commands.ts';
import { closeOpened, messageOf, type Opened, tick, wireDriver } from './driver-wiring.ts';
import { printable } from './run.ts';
import { formatNotice, INTERVAL_MS, type ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';
import { describeLane } from './status.ts';

/** What `foedrum brew` brews, as whom, and who asked. */
export interface BrewRequest {
  target: OrderTarget;
  /** The driver's owner: its lock's and its leases' (ADR 0037). */
  owner: string;
  /** Who runs it, recorded on an order it makes (ADR 0105) and on a takeover (ADR 0124). */
  by: string;
  via: Surface;
  /** `--take`: take the batch over from the driver that holds it, instead of refusing it. */
  take?: true;
  /** `foedrum mash`: route the batch to mash-in and drive it to its question (ADR 0232). */
  mash?: true;
  /**
   * Why it opens no interactive step's session, when it does not (ADR 0222): it runs inside Claude
   * Code, or its stdin is no terminal. Its driver then parks such a step's attempt.
   */
  noSessions?: 'claude-code' | 'no-terminal';
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

/** The recipe `foedrum mash` routes an issue to: the Innkeeper's question (ADR 0232). */
export const MASH_IN = 'mash-in';

/**
 * Why `foedrum mash` cannot route the issue's batch to mash-in (ADR 0232), or undefined: the batch
 * already started a recipe, the Brewery has no mash-in, or fewer than two recipes for it to offer.
 */
const mashRefusal = (
  setup: ServeSetup,
  latest: Batch | undefined,
  named: string,
): string | undefined => {
  if (latest?.recipe !== undefined) {
    const { id, recipe } = latest;
    return `batch ${id} of ${named} already brews the recipe ${recipe.name}; foedrum recipe ${id} <recipe> <reason> brews it with another`;
  }
  const mashIn = setup.recipes.find(MASH_IN);
  if (mashIn === undefined) return `the Brewery has no recipe ${MASH_IN}`;
  const choices = setup.brewers.find(MASH_IN, mashIn.firstStep)?.choices ?? [];
  // A question needs two options (ADR 0006).
  if (choices.length >= 2) return undefined;
  const later = '(decoction comes with #587)';
  const [only] = choices;
  return only === undefined
    ? `the Brewery has no recipe to offer but ${MASH_IN} ${later}`
    : `the Brewery has one recipe to offer, ${only.name}: label ${named} recipe:${only.name} to brew it ${later}`;
};

/** The line feed and the Unicode line and paragraph separators, which end a line. */
const BREAKS = new Set([0x0a, 0x2028, 0x2029]);

/** `text` with each line break shown as a `\uXXXX` escape, as `printable` shows the rest. */
export const oneLine = (text: string): string =>
  [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return BREAKS.has(code) ? `\\u${code.toString(16).padStart(4, '0')}` : char;
    })
    .join('');

/** Who drives a batch another driver holds, and until when. */
export const drivenBy = (lease: BatchLease): string =>
  `batch ${lease.batchId} is driven by ${lease.owner} until ${lease.expiresAt.toISOString()}`;

/** How often `foedrum brew` says which steps still run, when nothing else changed. */
const PROGRESS_MS = 30_000;

/** An attempt of `batch` that runs now: named `<step> #<n>`, and the ref the driver reports it by. */
interface Running {
  label: string;
  ref: AttemptRef;
}

/** The attempts of `batch` that run now. */
export const runningAttempts = (batch: Batch): Running[] =>
  [...batch.steps.values()].flatMap(({ id, attempts }) =>
    [...attempts.values()]
      .filter((attempt) => attempt.phase === 'started' && attempt.abandoned !== true)
      .map(({ attempt }) => ({
        label: `${id} #${attempt}`,
        ref: { batchId: batch.id, stepId: id, attempt },
      })),
  );

/** `ms` as whole seconds, and minutes from one: `30s`, `1m 0s`. */
export const elapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** The frames of the live line's spinner, one at each redraw (ADR 0174). */
const SPINNER = '|/-\\';
/** How often the live line is redrawn, apart from the tick. */
const REDRAW_MS = 1000;
/** The longest a tool's name is shown, before it is escaped. */
const TOOL_NAME_MAX = 64;
/** The width of a terminal that does not say. */
const UNKNOWN_COLUMNS = 80;

/** What the live line shows of one running attempt, in the order of ADR 0174. */
const attemptText = (label: string, ms: number, progress: AttemptProgress | undefined): string => {
  const parts = [label, elapsed(ms)];
  if (progress?.settingUp === true) {
    parts.push('setup');
  } else {
    if (progress?.turn !== undefined) parts.push(`turn ${progress.turn}`);
    const tool = progress?.lastTool;
    if (tool !== undefined) {
      const name = tool.name.slice(0, TOOL_NAME_MAX);
      parts.push(tool.word === undefined ? name : `${name} ${tool.word}`);
    }
    if (progress?.denied === true) parts.push('denied');
  }
  return parts.join(' / ');
};

/**
 * `line` in ASCII only (every UTF-16 unit outside U+0020 to U+007E as a `\uXXXX` escape), cut from
 * the end to one character less than the terminal's width (ADR 0174, ADR 0179, ADR 0188).
 */
export const fit = (line: string, columns: number | undefined): string =>
  line
    .replace(/[^ -~]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .slice(0, Math.max(0, (columns ?? UNKNOWN_COLUMNS) - 1));

/** The live line: `frame`, the batch's time, then the attempts, fitted to the terminal. */
const liveLine = (
  frame: string,
  batchTime: string,
  attempts: readonly string[],
  columns: number | undefined,
) => fit(`${frame} ${batchTime} / ${attempts.join(' ; ')}`, columns);

/** Brews the batch of `request.target` until it stops; the exit code of ADR 0123. */
export const runBrew = async (
  setup: ServeSetup,
  shell: ServeShell,
  request: BrewRequest,
): Promise<number> => {
  const { out, signal, clock, wait, intervalMs = INTERVAL_MS, terminal } = shell;
  const { target, owner, by, via } = request;
  // The live line (ADR 0174), drawn only with a terminal: when the batch was ordered (this run's
  // start until the batch says, ADR 0179), the attempts that run, when this driver first saw each
  // run, what the driver reports of one, and whether the line is on screen.
  let orderedAt = clock().getTime();
  let brewing: Running[] = [];
  const seenAt = new Map<string, number>();
  let progressOf: (ref: AttemptRef) => AttemptProgress | undefined = () => undefined;
  let frame = 0;
  let onScreen = false;
  const clearLive = (): void => {
    if (!onScreen) return;
    terminal?.clear();
    onScreen = false;
  };
  const draw = (): void => {
    if (terminal === undefined) return;
    if (brewing.length === 0) {
      clearLive();
      return;
    }
    const at = clock().getTime();
    const attempts = brewing.map(({ label, ref }) =>
      attemptText(label, at - (seenAt.get(label) ?? at), progressOf(ref)),
    );
    const spinner = SPINNER.charAt(frame++ % SPINNER.length);
    const batchTime = elapsed(Math.max(0, at - orderedAt));
    terminal.rewrite(liveLine(spinner, batchTime, attempts, terminal.columns()));
    onScreen = true;
  };
  // Notices and questions may carry text a model wrote: never a control character on the
  // terminal, and never a line break, which would forge a line the session acts on (ADR 0123).
  // A lasting line goes over the live line: it clears it, prints, and draws it again.
  const say = (line: string): void => {
    const wasOnScreen = onScreen;
    clearLive();
    out(oneLine(printable(`foedrum ${request.mash === true ? 'mash' : 'brew'}: ${line}`)));
    if (wasOnScreen) draw();
  };
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
  let order: OrderIssue = repository === undefined ? { issue } : { issue, repo: repository.repo };
  // As `foedrum status` names it.
  const named = `${order.repo ?? ''}#${issue}`;
  const asGiven = `${alias ?? ''}#${issue}`;
  // The lock first: a second brew under this owner is refused before it touches anything.
  let lock: Opened['lock'];
  try {
    lock = shell.lock(setup.workRoot, { brewery: setup.brewery, owner });
  } catch (error) {
    // A second terminal under the same owner may run beside the first under a name of its own.
    const beside =
      error instanceof DriverRunningError
        ? ', or give --as <name> to run another driver beside it'
        : '';
    return refuse(`${messageOf(error)}${beside}`);
  }
  const opened: Opened = { lock };
  let batchId: string | undefined;
  // Another driver's lease of the batch, once this driver lost it or never got it.
  let holder: BatchLease | undefined;
  let stopResize: (() => void) | undefined;
  const report = (notice: DriverNotice): void => {
    if (notice.kind === 'batch_lost' && notice.batchId === batchId) holder = notice.holder;
    say(formatNotice(notice));
  };
  try {
    const { store, driver, reads, claims } = await wireDriver(setup, shell, opened, {
      // This batch alone, once it is known (ADR 0044).
      takes: (id) => id === batchId,
      // None of the batches this owner left earlier: they lapse within a lease (ADR 0123).
      drivesOn: () => false,
      // An interactive step's session opens on a terminal outside Claude Code (ADR 0222).
      sessions: request.noSessions === undefined,
      say,
      report,
    });
    progressOf = (ref) => driver.progress(ref);
    const log = createCommandLog({ store, recipes: setup.recipes });
    const heldElsewhere = (id: string): BatchLease | undefined =>
      store.batchLeases(clock()).find((lease) => lease.batchId === id && lease.owner !== owner);

    // A claimed issue is mashed by its Brewery issue, its order (ADR 0232).
    const claimed =
      request.mash === true &&
      latestBatch(log.state().batches.values(), issue, undefined) === undefined
        ? claimOfOrder(log.state(), issue)
        : undefined;
    if (claimed?.repo !== undefined) order = { issue: claimed.issue, repo: claimed.repo };
    const latest = latestBatch(log.state().batches.values(), order.issue, order.repo);
    if (
      latest !== undefined &&
      (latest.lane.kind === 'on_tap' || latest.lane.kind === 'cancelled')
    ) {
      const { lane } = describeLane(latest);
      return refuse(
        `batch ${latest.id} of ${named} is ${lane}; foedrum order ${asGiven} orders it again`,
      );
    }
    // A paused order would wait with nothing to do: it is continued first (ADR 0202).
    // A sub-order's batch waits for its order's pause, which is the one to continue.
    const pausedLine = (state: State, batch: Batch | undefined): string => {
      if (state.pauses.all !== undefined) {
        return 'the Brewery is paused; foedrum continue --all lets it brew';
      }
      const held = batch === undefined ? undefined : orderOfBatch(state, batch);
      if (held === undefined || held.issue === issue) {
        return `${named} is paused; foedrum continue ${asGiven} lets it brew`;
      }
      return `${named} is a sub-order of #${held.issue}, which is paused; foedrum continue #${held.issue} lets it brew`;
    };
    if (
      log.state().pauses.all !== undefined ||
      (latest !== undefined && pauseOf(log.state(), latest) !== undefined)
    ) {
      return refuse(pausedLine(log.state(), latest));
    }
    const leased = latest === undefined ? undefined : heldElsewhere(latest.id);
    if (leased !== undefined && request.take !== true) return refuse(drivenBy(leased));
    // An issue with no batch, or an Ordered one, is routed by its one recipe label (ADR 0068).
    let recipe: string | undefined;
    if (request.mash === true) {
      const refused = mashRefusal(setup, latest, named);
      if (refused !== undefined) return refuse(refused);
    } else if (latest === undefined || latest.lane.kind === 'ordered') {
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
      // Checked before anything is ordered or claimed, as the intake leaves it unrouted.
      if (recipe !== undefined && setup.recipes.find(recipe) === undefined) {
        return refuse(`${named} carries recipe:${recipe}, which names no recipe of this Brewery`);
      }
    }
    // --take, once nothing else refuses the brew: the batch is this driver's at once, and the one
    // that held it stops (ADR 0124). A lease that lapsed meanwhile leaves nothing to take over.
    if (leased !== undefined) {
      const handover = { batchId: leased.batchId, owner, by, via, now: clock(), leaseMs };
      const decision = takeOver(log, handover);
      const [handed] = decision.kind === 'accepted' ? decision.events : [];
      if (handed?.type === 'batch.taken_over') {
        say(`took batch ${leased.batchId} over from ${handed.from}`);
      } else if (heldElsewhere(leased.batchId) !== undefined && decision.kind === 'refused') {
        return refuse(decision.reason);
      }
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
    const batch = latestBatch(log.state().batches.values(), order.issue, order.repo);
    if (batch === undefined) throw new Error(`${named} has no batch after its order`);
    batchId = batch.id;
    if (request.mash === true && batch.recipe === undefined) {
      const mashIn = {
        kind: 'recipe',
        batchId,
        recipe: MASH_IN,
        reason: 'the engineer ran foedrum mash',
        by,
        via,
      } as const;
      const decision = log.issue(mashIn, clock());
      if (decision.kind === 'refused') return refuse(decision.reason);
      say(`routed batch ${batchId} to the recipe ${MASH_IN}`);
    }
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
    // What opens the session a batch waits for, as this brew can or cannot (ADR 0222).
    const sessionLine = (why: BrewRequest['noSessions']): string => {
      switch (why) {
        case undefined:
          return `run foedrum brew ${asGiven} again to reopen the session`;
        case 'claude-code':
          return `run foedrum brew ${asGiven} in a terminal to open its session`;
        case 'no-terminal':
          return `stdin is not a terminal, and claude needs one: run foedrum brew ${asGiven} in a terminal`;
        default: {
          const unhandled: never = why;
          throw new Error(`Unhandled reason ${JSON.stringify(unhandled)}`);
        }
      }
    };
    // A batch that waits for a session when a brew that opens one starts: the person runs it now,
    // once; within the run the batch never retries by itself (ADR 0222).
    const { lane: found } = batch;
    if (
      request.noSessions === undefined &&
      found.kind === 'stuck' &&
      found.reason.kind === 'waiting_for_session'
    ) {
      const decision = log.issue({ kind: 'retry', batchId, by, via }, clock());
      if (decision.kind === 'refused') return refuse(decision.reason);
      say(`batch ${batchId} waits for a session at ${found.reason.stepId}; opening it`);
    }
    say(`brewing batch ${batchId} as ${owner}`);

    /**
     * Until the next tick: plain, one wait; on a terminal, a redraw each second (ADR 0174),
     * counted rather than read off the clock, so a clock set back cannot hold the tick off.
     */
    const pause = async (): Promise<void> => {
      if (terminal === undefined) return wait(intervalMs, signal);
      const redraws = Math.max(1, Math.ceil(intervalMs / REDRAW_MS));
      for (let each = 0; each < redraws && !signal.aborted; each++) {
        draw();
        await wait(Math.min(REDRAW_MS, intervalMs), signal);
      }
    };

    /**
     * After a takeover from this driver that resumes a step, the ends of the runs it stopped there,
     * recorded at the step boundary before brew lets its driver go, within a lease: the new holder
     * waits for their leases before it continues the session (ADR 0127). A closed driver records
     * no end, and its runs' leases would hold the step for a whole lease.
     */
    const endStoppedRuns = async (id: string, holder: BatchLease): Promise<void> => {
      const takeover = driver.state().batches.get(id)?.takeover;
      if (takeover?.from !== owner || takeover.resumes === undefined) return;
      // A takeover whose owner let the batch go since resumes nothing now (ADR 0127).
      if (holder.owner !== takeover.to) return;
      const until = clock().getTime() + leaseMs;
      const running = () =>
        store
          .currentLeases(clock())
          .some(
            (lease) => lease.owner === owner && attemptKey.decode(lease.attemptKey)?.batchId === id,
          );
      while (running() && clock().getTime() < until && !signal.aborted) {
        await pause();
        await tick(driver, report);
      }
    };

    let shown = '';
    // When the last line was said, and when this driver first saw each attempt run.
    let saidAt = clock().getTime();
    let linked = false;
    stopResize = terminal?.onResize(draw);
    for (;;) {
      await tick(driver, report);
      const other = holder ?? heldElsewhere(batchId);
      if (other !== undefined) {
        await endStoppedRuns(batchId, other);
        return refuse(drivenBy(other));
      }
      const now = driver.state().batches.get(batchId) as Batch;
      const { lane, detail } = describeLane(now);
      // The status comment, on the batch's Brewery issue, once its first revision is recorded
      // (ADR 0072, ADR 0155).
      const comment = linked ? undefined : statusCommentOf(driver.state(), batchId);
      const shownOn = breweryIssueOf(driver.state(), now);
      const commentUrl = (id: number): string =>
        `https://${setup.github.hostname}/${setup.brewery}/issues/${shownOn}#issuecomment-${id}`;
      if (comment !== undefined && shownOn !== undefined) {
        linked = true;
        say(`status comment: ${commentUrl(comment)}`);
      }
      // Let go: every effect of the ended batch is applied (ADR 0044).
      const released = !driver.held().includes(batchId);
      switch (now.lane.kind) {
        case 'on_tap': {
          if (!released) break;
          const { pullRequests } = now.lane;
          if (pullRequests.length > 0) {
            say(`batch ${batchId} is on tap: ${pullRequests.join(' ')}`);
            return BREW_EXIT.onTap;
          }
          // With none, what it left instead: a plan's comment (#656).
          const plan = planCommentOf(driver.state(), batchId);
          const shown =
            plan === undefined || shownOn === undefined ? '' : `; the plan: ${commentUrl(plan)}`;
          say(`batch ${batchId} is on tap: no pull request${shown}`);
          return BREW_EXIT.onTap;
        }
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
          if (reason.kind === 'waiting_for_session') say(sessionLine(request.noSessions));
          return BREW_EXIT.stuck;
        }
        case 'brewing':
          // A pause that came while it brews: once nothing of the batch runs, nothing will
          // until a person continues it (ADR 0202).
          if (pauseOf(driver.state(), now) !== undefined && runningAttempts(now).length === 0) {
            return refuse(pausedLine(driver.state(), now));
          }
          break;
        case 'ordered':
        case 'conditioning':
          break;
        default: {
          const unknown: never = now.lane;
          throw new Error(`Unknown lane ${JSON.stringify(unknown)}`);
        }
      }
      const line = `batch ${batchId} ${lane}${detail === '' ? '' : `: ${detail}`}`;
      const at = clock().getTime();
      if (now.orderedAt !== undefined) orderedAt = Date.parse(now.orderedAt);
      const running = runningAttempts(now);
      for (const { label } of running) if (!seenAt.has(label)) seenAt.set(label, at);
      brewing = running;
      if (line !== shown) {
        shown = line;
        saidAt = at;
        // On tap, the last line says it once its effects are applied (#662).
        if (now.lane.kind !== 'on_tap') say(line);
      } else if (terminal === undefined && running.length > 0 && at - saidAt >= PROGRESS_MS) {
        // A step can run for many minutes in silence: say it still runs (#406).
        saidAt = at;
        const runs = running.map(
          ({ label }) => `${label} running for ${elapsed(at - (seenAt.get(label) ?? at))}`,
        );
        say(`batch ${batchId} ${lane}: ${runs.join(', ')}`);
      }
      if (signal.aborted) break;
      await pause();
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
    // The live line goes before any exit, so the last lines on screen are the lasting ones.
    stopResize?.();
    clearLive();
    // Closing the driver stops its runs and lets the lock go; a Stuck batch keeps its lease.
    try {
      closeOpened(opened);
    } finally {
      shell.awake?.release();
    }
  }
};
