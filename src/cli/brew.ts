// `foedrum brew`, the interactive driver of one batch (ADR 0123): under an owner of its own (`--as`,
// or the Claude Code session it runs in, else `terminal`), it takes that owner's lock, opens the
// driver on the wiring it shares with `foedrum serve` (driver-wiring.ts) with `takes` that batch
// alone, orders and routes the issue first when it has no batch (a claimed one only by its Brewery
// issue, ADR 0156), and ticks until the batch is on tap, cancelled or Stuck. Its exit code says
// which, so the plugin's session can ask the engineer and brew again.
// `foedrum mash` routes the batch to mash-in first (ADR 0232), and `foedrum lauter` records a
// person's lauter of the plan its batch waits with first, so its session opens (ADR 0286).
// On a terminal (the shell gives one) it keeps a live line, from the command's first second to its
// last, of what the command does and of what the running attempts do (ADR 0174, ADR 0346).

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { defaultLeaseMs as leaseMs, releaseBatch, takeOver } from '../engine/batch-leases.ts';
import { closeStillDue } from '../engine/brewery-closes.ts';
import {
  breweryIssueOf,
  calledAs,
  claimOrderOf,
  claimStandingOf,
  latestBatch,
  liveOrderOf,
  namedWork,
  saidAs,
} from '../engine/claim-orders.ts';
import { createCommandLog } from '../engine/command-log.ts';
import { orderRefusal } from '../engine/decide.ts';
import type { Doing, DriverNotice } from '../engine/driver.ts';
import { DriverRunningError } from '../engine/driver-lock.ts';
import type { BatchLease } from '../engine/event-store.ts';
import { type Batch, foldedBatch, type State, unendedPullRequests } from '../engine/fold.ts';
import { type PullRequestEnded, recipeLabels, recordEndsOf } from '../engine/intake.ts';
import { orderEffects } from '../engine/issue-claims.ts';
import { orderOfBatch, pauseOf } from '../engine/pauses.ts';
import { planCommentOf } from '../engine/plan-comment.ts';
import { MASH_IN } from '../engine/recipe-label.ts';
import { statusCommentOf } from '../engine/status-comment.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { githubOrderLabels, type OrderIssue } from '../github/order-text.ts';
import { githubTargetTracker } from '../github/tracker.ts';
import { messageOf } from '../platform/errors.ts';
import type { OrderTarget } from '../schemas/commands.ts';
import type { Surface } from '../schemas/events.ts';
import { type OrderClaim, orderIssue } from './commands.ts';
import { closeOpened, type Opened, tick, wireDriver } from './driver-wiring.ts';
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
  /** `foedrum lauter <issue>`: the batch whose plan a session corrects, taking it over (ADR 0286). */
  lauter?: string;
  /**
   * Why it opens no interactive step's session, when it does not (ADR 0222): it runs inside Claude
   * Code, or its stdin is no terminal. Its driver then parks such a step's attempt.
   */
  noSessions?: 'claude-code' | 'no-terminal';
}

/** The command a request runs as, which its lines name. */
const commandOf = (request: BrewRequest): string => {
  if (request.mash === true) return 'mash';
  return request.lauter !== undefined ? 'lauter' : 'brew';
};

/** How `foedrum brew` ends (ADR 0123); 2, a wrong command line, is the terminal's. */
export const BREW_EXIT = {
  onTap: 0,
  failed: 1,
  stuck: 3,
  needsInput: 4,
  refused: 5,
  cancelled: 6,
} as const;

/** The lines of a batch that needs input: each question numbered as `foedrum answer` takes it. */
const questionLines = (state: State, stepId: string, batch: Batch): string[] => {
  const { lane } = batch;
  if (lane.kind !== 'stuck' || lane.reason.kind !== 'needs_input') return [];
  const { questions } = lane.reason;
  return [
    `${saidAs(state, batch)} needs input at ${stepId}:`,
    ...questions.flatMap(({ q, options, recommended, whyBlocking }, n) => [
      `  ${n + 1}. ${q} (${options.join(', ')}; recommended: ${recommended})`,
      `     why it blocks: ${whyBlocking}`,
    ]),
    `answer them in order with foedrum answer ${calledAs(state, batch)} ${questions.map((_, n) => `<answer ${n + 1}>`).join(' ')}, then brew again`,
  ];
};

/**
 * Why `foedrum mash` cannot route the issue's batch to mash-in (ADR 0232), or undefined: the batch
 * already started a recipe, the Brewery has no mash-in, or fewer than two recipes for it to offer.
 */
const mashRefusal = (
  setup: ServeSetup,
  latest: Batch | undefined,
  named: string,
  called: string,
): string | undefined => {
  if (latest?.recipe !== undefined) {
    return `${named} already brews the recipe ${latest.recipe.name}; foedrum recipe ${called} <recipe> <reason> brews it with another`;
  }
  const mashIn = setup.recipes.find(MASH_IN);
  if (mashIn === undefined) return `the Brewery has no recipe ${MASH_IN}`;
  const choices = setup.brewers.find(MASH_IN, mashIn.firstStep)?.choices ?? [];
  // A question needs two options (ADR 0006).
  if (choices.length >= 2) return undefined;
  const [only] = choices;
  return only === undefined
    ? `the Brewery has no recipe to offer but ${MASH_IN}`
    : `the Brewery has one recipe to offer, ${only.name}: label ${named} recipe:${only.name} to brew it`;
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

/**
 * Who drives a batch another driver holds, until when, and `wayOn`, what a person can do about it.
 * It never says that driver stopped, which Foedrum cannot tell (ADR 0336).
 */
export const drivenBy = (state: State, lease: BatchLease, wayOn: string): string =>
  `${saidAs(state, foldedBatch(state, lease.batchId))} is driven by ${lease.owner} until ${lease.expiresAt.toISOString()}, when its lease ends by itself; ${wayOn}`;

/** What brewing an on-tap batch did once its pull requests ended and its effects applied (ADR 0336). */
const endedLine = (
  said: string,
  batch: Batch,
  urls: readonly string[],
  order: number | undefined,
): string => {
  const merged = urls.every((url) => batch.pullRequestEnds?.[url] === 'merged');
  const ended = merged
    ? `${said} merged: ${urls.join(' ')}`
    : `${said} ended: ${urls.join(' ')} not all merged`;
  const issue =
    order === undefined ? [] : [`Brewery issue #${order} ${merged ? 'closed' : 'stays open'}`];
  const unassign = merged ? '' : ', unassign it to make it available';
  const claim =
    batch.repo === undefined ? [] : [`claim on ${batch.repo}#${batch.issue} released${unassign}`];
  const what = [...issue, ...claim].join(', ');
  return what === '' ? ended : `${ended}; ${what}`;
};

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

/** The attempts of `batch` that started, named `<step> #<n>`, whether they run now or ended. */
const startedLabels = (batch: Batch): string[] =>
  [...batch.steps.values()].flatMap(({ id, attempts }) =>
    [...attempts.values()]
      .filter(({ phase }) => phase !== 'scheduled')
      .map(({ attempt }) => `${id} #${attempt}`),
  );

/** `ms` as whole seconds, and minutes from one: `30s`, `1m 0s`. */
export const elapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** How often the moving mark turns, as `gh`'s does (ADR 0346). */
const MARK_MS = 120;
/** How often the live line's words are read again and redrawn, apart from the tick. */
const REDRAW_MS = 1000;
/** What holds the mark's column while a line is fitted to the terminal. */
const MARK_ROOM = '|';
/** The longest a tool's name is shown, before it is escaped. */
const TOOL_NAME_MAX = 64;
/** The width of a terminal that does not say. */
const UNKNOWN_COLUMNS = 80;

/** What the live line shows of one running attempt, in the order of ADR 0174, one part each. */
const attemptParts = (
  label: string,
  ms: number,
  progress: AttemptProgress | undefined,
): string[] => {
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
  return parts;
};

/** `line` in ASCII only: every UTF-16 unit outside U+0020 to U+007E as a `\uXXXX` escape. */
const ascii = (line: string): string =>
  line.replace(/[^ -~]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * `line` in ASCII only, cut from the end to one character less than the terminal's width
 * (ADR 0174, ADR 0179, ADR 0188).
 */
export const fit = (line: string, columns: number | undefined): string =>
  ascii(line).slice(0, Math.max(0, (columns ?? UNKNOWN_COLUMNS) - 1));

/**
 * The live line: a column for the mark, the batch's time with its words (ADR 0326), then the
 * attempts, each in its parts, fitted to the terminal. Side by side, attempts give up their last
 * parts together before any of them is cut off (ADR 0346).
 */
const liveLine = (
  batchTime: string,
  attempts: readonly (readonly string[])[],
  columns: number | undefined,
) => {
  const joined = (keep: number): string =>
    `${MARK_ROOM} ${batchTime} / ${attempts.map((parts) => parts.slice(0, keep).join(' / ')).join(' ; ')}`;
  let keep = Math.max(...attempts.map((parts) => parts.length));
  while (
    attempts.length > 1 &&
    keep > 1 &&
    ascii(joined(keep)).length > (columns ?? UNKNOWN_COLUMNS) - 1
  ) {
    keep--;
  }
  return fit(joined(keep), columns);
};

/** What the live line says while the driver spends time on `what`. */
const doingWords = (what: Doing): string => {
  if (what.kind === 'clean') return 'cleaning up the worktrees of the batch';
  const { effect } = what.key;
  if (effect.startsWith('status.')) return 'writing the status comment';
  if (effect === orderEffects.open) return 'opening the Brewery issue';
  if (/^(?:push|pull_request|body)(?:\.|$)/.test(effect)) return 'opening the pull request';
  return `applying ${effect}`;
};

/** A turn of the event loop, so a call that needs no time ends before the live line waits beside it. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Brews the batch of `request.target` until it stops; the exit code of ADR 0123. */
export const runBrew = async (
  setup: ServeSetup,
  shell: ServeShell,
  request: BrewRequest,
): Promise<number> => {
  const { out, signal, clock, wait, intervalMs = INTERVAL_MS, terminal } = shell;
  const { target, owner, by, via } = request;
  // The live line (ADR 0174), drawn only with a terminal, from this command's first second (ADR 0346):
  // what the batch's time counts from and says (this run's start until the batch says when it was
  // ordered, ADR 0179, ADR 0326), the attempts that run, when this driver first saw each run, what
  // the driver reports of one, what the command does while a call takes time, and whether the
  // line is on screen.
  let batchClock = { words: 'brew started', from: clock().getTime() };
  /** The batch's time counts from when `batch` was ordered, once it says when. */
  const countFromOrder = (batch: Batch): void => {
    if (batch.orderedAt !== undefined) {
      batchClock = { words: 'ordered', from: Date.parse(batch.orderedAt) };
    }
  };
  let brewingNow: () => Running[] = () => [];
  const seenAt = new Map<string, number>();
  let progressOf: (ref: AttemptRef) => AttemptProgress | undefined = () => undefined;
  let doing: string | undefined;
  let frame = 0;
  // The line last fitted to the terminal, with the column its mark goes in, and whether it shows.
  let fitted: string | undefined;
  let onScreen = false;
  const clearLive = (): void => {
    if (!onScreen) return;
    terminal?.clear();
    onScreen = false;
  };
  /** When this driver first saw the attempt `label` run: `at` when it sees it now for the first time. */
  const firstSeen = (label: string, at: number): number => {
    const first = seenAt.get(label);
    if (first !== undefined) return first;
    seenAt.set(label, at);
    return at;
  };
  const noticed = (attempts: readonly Running[], at: number): void => {
    for (const { label } of attempts) firstSeen(label, at);
  };
  /** The line last fitted, with the mark's frame now in its first column, if it has one. */
  const show = (): void => {
    if (terminal === undefined || fitted === undefined) return;
    const mark = terminal.marks[frame % terminal.marks.length] ?? MARK_ROOM;
    terminal.rewrite(fitted.replace(/^./, () => mark));
    onScreen = true;
  };
  const draw = (): void => {
    if (terminal === undefined) return;
    const at = clock().getTime();
    const brewing = brewingNow();
    noticed(brewing, at);
    // What it does now, else the attempts that run now, else that nothing runs between two steps.
    const attempts =
      doing !== undefined
        ? [[doing]]
        : brewing.length === 0
          ? [['between steps']]
          : brewing.map(({ label, ref }) =>
              attemptParts(label, at - firstSeen(label, at), progressOf(ref)),
            );
    const batchTime = `${batchClock.words} ${elapsed(Math.max(0, at - batchClock.from))} ago`;
    fitted = liveLine(batchTime, attempts, terminal.columns());
    show();
  };
  // The mark turns on a timer of its own, writing the fitted line again: no state is read and no
  // tick is moved for it (ADR 0346). A throw here is the line's alone, as beside a call below.
  const marksEnd = new AbortController();
  const turning = AbortSignal.any([signal, marksEnd.signal]);
  const turnMarks = async (): Promise<void> => {
    while (terminal !== undefined && !turning.aborted) {
      await turn();
      if (turning.aborted) break;
      await wait(MARK_MS, turning);
      if (turning.aborted) break;
      frame++;
      show();
    }
  };
  /**
   * Awaits `call` with the live line moving beside it: `words` say what it does (the driver's own
   * `doing` may say more), redrawn each second on the shell's wait, which a call that takes no
   * time never reaches. Plain, it only awaits.
   */
  const lively = async <T>(words: string | undefined, call: () => Promise<T>): Promise<T> => {
    if (terminal === undefined) return call();
    doing = words;
    const stop = new AbortController();
    const redraws = AbortSignal.any([signal, stop.signal]);
    if (words !== undefined || !onScreen) draw();
    // A redraw that throws ends this loop, never the call beside it or the process: the next
    // redraw of the brew's own says what failed, if it still does.
    const moving = (async () => {
      while (!redraws.aborted) {
        await turn();
        if (redraws.aborted) break;
        await wait(REDRAW_MS, redraws);
        if (!redraws.aborted) draw();
      }
    })().catch(() => {});
    try {
      return await call();
    } finally {
      stop.abort();
      await moving;
      doing = undefined;
    }
  };
  // Notices and questions may carry text a model wrote: never a control character on the
  // terminal, and never a line break, which would forge a line the session acts on (ADR 0123).
  // A lasting line goes over the live line: it clears it, prints, and draws it again.
  const say = (line: string): void => {
    const wasOnScreen = onScreen;
    clearLive();
    out(oneLine(printable(`foedrum ${commandOf(request)}: ${line}`)));
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
  // As it was given: its number, or the target issue until that is alive (ADR 0329).
  const named = `${alias ?? ''}#${issue}`;
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
  let marks: Promise<void> | undefined;
  const report = (notice: DriverNotice): void => {
    if (notice.kind === 'batch_lost' && notice.batchId === batchId) holder = notice.holder;
    say(formatNotice(notice));
  };
  try {
    stopResize = terminal?.onResize(draw);
    marks = turnMarks().catch(() => {});
    const { store, driver, reads, claims } = await lively('starting', () =>
      wireDriver(setup, shell, opened, {
        // This batch alone, once it is known (ADR 0044).
        takes: (id) => id === batchId,
        // None of the batches this owner left earlier: they lapse within a lease (ADR 0123).
        drivesOn: () => false,
        // An interactive step's session opens on a terminal outside Claude Code (ADR 0222).
        sessions: request.noSessions === undefined,
        say,
        report,
        doing: (what) => {
          doing = doingWords(what);
          draw();
        },
      }),
    );
    progressOf = (ref) => driver.progress(ref);
    const log = createCommandLog({ store, recipes: setup.recipes });
    const heldElsewhere = (id: string): BatchLease | undefined =>
      store.batchLeases(clock()).find((lease) => lease.batchId === id && lease.owner !== owner);

    // A claimed issue is brewed and mashed by its Brewery issue, its order (ADR 0232, ADR 0240),
    // and by that number alone once it is alive (ADR 0329).
    const work = namedWork(log.state(), target, () => repository?.repo, commandOf(request));
    if ('refused' in work) return refuse(work.refused);
    order = work.order;
    const { batch: last } = work;
    // How a line offers it now: its number, or its target issue until the number is alive.
    const called = (state: State): string => {
      if (repository === undefined) return String(issue);
      const alive = liveOrderOf(state, { issue, repo: repository.repo });
      return alive === undefined ? named : String(alive);
    };
    // A batch that ended cannot be taken over (ADR 0124): its lease ends, and brew tries again.
    const wayOn = (state: State, held: Batch): string =>
      held.lane.kind === 'on_tap' || held.lane.kind === 'cancelled'
        ? `foedrum brew ${called(state)} tries again then`
        : `foedrum ${request.mash === true ? 'mash' : 'brew'} ${called(state)} --take takes it over now`;
    const orderAgainLine = (state: State, batch: Batch): string => {
      const { lane } = describeLane(batch, called(state));
      return `${named} is ${lane}; foedrum order ${called(state)} orders it again`;
    };
    // A target issue that ended and whose Brewery issue a person deleted is claimed anew.
    const knew = last === undefined ? {} : claimOrderOf(log.state(), last.id);
    const deleted =
      alias !== undefined &&
      (last?.lane.kind === 'on_tap' || last?.lane.kind === 'cancelled') &&
      (knew.issue !== undefined || knew.earlier !== undefined);
    const latest = deleted ? undefined : last;
    // Brewing an on-tap batch records the ends of its pull requests and applies what follows, for a
    // person with no Cellar (ADR 0336); a mash or a lauter of one keeps its own refusal.
    // A Brewery issue's batch has no claim to hold, but its open pull request refuses a new order
    // all the same (ADR 0339).
    const openLine = (state: State, batch: Batch): string => {
      // Only its decomposition orders a sub-order, so closing it opens no order to a person.
      const close = state.subOrders.has(batch.issue)
        ? ''
        : 'close it first to order it again, and ';
      return `${named} is on tap with its pull request still open: ${unendedPullRequests(batch).join(' ')}; ${close}foedrum brew ${called(state)} reads it again once it ended`;
    };
    const heldLine = (state: State, batch: Batch): string =>
      `${named} is on tap and holds its claim until its pull requests end: ${unendedPullRequests(batch).join(' ')}; foedrum brew ${called(state)} reads them again`;
    const standing =
      latest?.repo === undefined ? undefined : claimStandingOf(log.state(), latest, latest.repo);
    const ending =
      commandOf(request) === 'brew' &&
      latest !== undefined &&
      (unendedPullRequests(latest).length > 0 ||
        standing === 'releasing' ||
        closeStillDue(log.state(), latest))
        ? latest
        : undefined;
    // A lauter names a batch, whose lane its refusal names (ADR 0286).
    if (request.lauter !== undefined && latest === undefined) {
      return refuse(`${named} has no batch to correct a plan of`);
    }
    if (
      request.lauter === undefined &&
      ending === undefined &&
      latest !== undefined &&
      (latest.lane.kind === 'on_tap' || latest.lane.kind === 'cancelled')
    ) {
      if (latest.lane.kind === 'on_tap' && standing === 'held') {
        return refuse(heldLine(log.state(), latest));
      }
      if (standing === 'releasing') {
        const { lane } = describeLane(latest, called(log.state()));
        return refuse(
          `${named} is ${lane}; its release is still due, and foedrum brew ${called(log.state())} finishes it`,
        );
      }
      // What an order would say, when it would be refused, in place of offering it (ADR 0339).
      return refuse(orderRefusal(log.state(), order) ?? orderAgainLine(log.state(), latest));
    }
    // A paused order would wait with nothing to do: it is continued first (ADR 0202).
    // A sub-order's batch waits for its order's pause, which is the one to continue.
    const pausedLine = (state: State, batch: Batch | undefined): string => {
      if (state.pauses.all !== undefined) {
        return 'the Brewery is paused; foedrum continue --all lets it brew';
      }
      const held = batch === undefined ? undefined : orderOfBatch(state, batch);
      // A claimed batch's order is its target issue, which its number names (ADR 0329).
      if (held === undefined || held.repo !== undefined || held.issue === issue) {
        return `${named} is paused; foedrum continue ${called(state)} lets it brew`;
      }
      return `${named} is a sub-order of #${held.issue}, which is paused; foedrum continue ${held.issue} lets it brew`;
    };
    if (
      log.state().pauses.all !== undefined ||
      (latest !== undefined && pauseOf(log.state(), latest) !== undefined)
    ) {
      return refuse(pausedLine(log.state(), latest));
    }
    const leased = latest === undefined ? undefined : heldElsewhere(latest.id);
    if (latest !== undefined && leased !== undefined && request.take !== true) {
      return refuse(drivenBy(log.state(), leased, wayOn(log.state(), latest)));
    }
    // The person's lauter first, so a refused one takes nothing over; its session opens below as
    // every interactive step's does (ADR 0286, ADR 0222).
    // It names its batch, never the issue's later one, whose lane the refusal names.
    if (request.lauter !== undefined && latest !== undefined) {
      const decision = log.issue({ kind: 'lauter', batchId: request.lauter, by, via }, clock());
      if (decision.kind === 'refused') return refuse(decision.reason);
      say(
        `${saidAs(log.state(), foldedBatch(log.state(), request.lauter))} goes to a session on its plan`,
      );
    }
    // An issue with no batch, or an Ordered one, is routed by its one recipe label (ADR 0068); a
    // claimed batch by its Brewery issue's, and it waits for that issue until the ledger records
    // it, never reading the target issue's (ADR 0156).
    const labelled = latest === undefined ? undefined : breweryIssueOf(log.state(), latest);
    const waitsForOrder =
      request.mash !== true && order.repo !== undefined && labelled === undefined;
    let recipe: string | undefined;
    if (request.mash === true) {
      const refused = mashRefusal(setup, latest, named, called(log.state()));
      if (refused !== undefined) return refuse(refused);
    } else if (!waitsForOrder && (latest === undefined || latest.lane.kind === 'ordered')) {
      const labels = githubOrderLabels(reads, setup.brewery);
      const on = await lively('routing', () =>
        labels(labelled === undefined ? order : { issue: labelled }, signal),
      );
      const names = recipeLabels(on);
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
        say(
          `took ${saidAs(log.state(), foldedBatch(log.state(), leased.batchId))} over from ${handed.from}`,
        );
      } else if (heldElsewhere(leased.batchId) !== undefined && decision.kind === 'refused') {
        return refuse(decision.reason);
      }
    }
    if (latest === undefined) {
      const claim: OrderClaim | undefined =
        repository === undefined
          ? undefined
          : { repo: repository.repo, alias: repository.alias, brewery: setup.brewery };
      const command = await lively(`claiming ${named}`, () =>
        orderIssue(log.state, order, claim, {
          claims: () => claims,
          now: clock(),
          issued: (id) => ({ batchId: id, by, via }),
        }),
      );
      if ('refused' in command) return refuse(command.refused);
      const decision = log.issue(command, clock());
      if (decision.kind === 'refused') return refuse(decision.reason);
      say(`ordered ${named}`);
    }
    const batch =
      latest === undefined
        ? latestBatch(log.state().batches.values(), order.issue, order.repo)
        : log.state().batches.get(latest.id);
    if (batch === undefined) throw new Error(`${named} has no batch after its order`);
    batchId = batch.id;
    brewingNow = () => runningAttempts(foldedBatch(driver.state(), batch.id));
    countFromOrder(batch);
    if (ending !== undefined) {
      const ends = {
        tracker: githubTargetTracker(reads),
        record: (event: PullRequestEnded) => log.issue({ kind: 'record', event }, clock()),
        // Nothing was released: the person hears why, and brews again.
        failed: (_what: string, error: unknown) => {
          throw error;
        },
      };
      await recordEndsOf(ending, unendedPullRequests(ending), ends, signal);
      const read = foldedBatch(log.state(), batch.id);
      if (unendedPullRequests(read).length > 0) {
        if (read.repo !== undefined) return refuse(heldLine(log.state(), read));
        return refuse(openLine(log.state(), read));
      }
    }
    if (waitsForOrder && batch.lane.kind === 'ordered') {
      // One tick applies the claim's effects, the Brewery issue among them (ADR 0144); a fresh
      // Brewery issue has no label yet, so the batch waits for a person to give it one.
      await lively(undefined, () => tick(driver, report));
      // A batch that waits for a person is not Stuck: it keeps no lease (ADR 0123).
      store.withTransaction((tx) => releaseBatch(tx, batch.id, owner));
      const opened = breweryIssueOf(driver.state(), batch);
      // A tick that did not open it (a failed or a put-off effect) said why first.
      if (opened === undefined) {
        say(`${named} waits for its Brewery issue, which is not open yet; brew ${named} again`);
        return BREW_EXIT.failed;
      }
      // A recipe label on the target issue chooses nothing (ADR 0156), and a person who put one
      // there would wait for it: the line says so, one conditional read on this refusal alone, and
      // is left out when that read fails (ADR 0336).
      const carried = await githubOrderLabels(reads, setup.brewery)(order, signal).then(
        recipeLabels,
        () => [],
      );
      if (carried.length > 0) {
        const all = carried.map((name) => `recipe:${name}`).join(' and ');
        say(`${named} carries ${all}, which Foedrum does not read; label #${opened}`);
      }
      // The bare number, which every shell passes as it is (cmd.exe keeps quotes).
      return refuse(
        `${named} waits for a recipe:<name> label on its Brewery issue #${opened}; label it and brew ${opened}, or foedrum mash ${opened}`,
      );
    }
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
      say(`routed ${saidAs(log.state(), batch)} to the recipe ${MASH_IN}`);
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
      say(`routed ${saidAs(log.state(), batch)} to the recipe ${recipe}`);
    }
    // What opens the session a batch waits for, as this brew can or cannot (ADR 0222).
    const sessionLine = (why: BrewRequest['noSessions'], state: State): string => {
      const brew = `foedrum brew ${called(state)}`;
      switch (why) {
        case undefined:
          return `run ${brew} again to reopen the session`;
        case 'claude-code':
          return `run ${brew} in a terminal to open its session`;
        case 'no-terminal':
          return `stdin is not a terminal, and claude needs one: run ${brew} in a terminal`;
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
      say(
        `${saidAs(log.state(), batch)} waits for a session at ${found.reason.stepId}; opening it`,
      );
    }
    say(
      ending === undefined
        ? `brewing ${saidAs(log.state(), batch)} as ${owner}`
        : `applying what the end of ${saidAs(log.state(), batch)} leaves due as ${owner}`,
    );

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
    // When the last line was said, and the attempts a line need not name as started: those that
    // started before this run began, which it saw none of (ADR 0346).
    let saidAt = clock().getTime();
    const lined = new Set(startedLabels(foldedBatch(log.state(), batchId)));
    let linked = false;
    // The Stuck lane brew last ticked once more after: a person may move the batch on in that tick,
    // and it may stick again before brew reads another lane (ADR 0275, ADR 0330).
    let settled: string | undefined;
    for (;;) {
      await lively(undefined, () => tick(driver, report));
      const other = holder ?? heldElsewhere(batchId);
      if (other !== undefined) {
        await endStoppedRuns(batchId, other);
        const held = foldedBatch(driver.state(), batchId);
        return refuse(drivenBy(driver.state(), other, wayOn(driver.state(), held)));
      }
      const now = foldedBatch(driver.state(), batchId);
      const { lane, detail } = describeLane(now, calledAs(driver.state(), now));
      const said = saidAs(driver.state(), now);
      // An attempt that started and ended since the last pass is named, though the lane no longer
      // says it ran: a group's Tasters all started, on a terminal or not (ADR 0346).
      const running = runningAttempts(now);
      const started = startedLabels(now);
      const lapsed = started.filter(
        (label) => !lined.has(label) && !running.some((each) => each.label === label),
      );
      for (const label of started) lined.add(label);
      if (lapsed.length > 0) {
        say(`${said} brewing: ${lapsed.map((label) => `${label} started`).join(', ')}`);
      }
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
          if (pullRequests.length > 0 && ending !== undefined) {
            say(endedLine(said, now, pullRequests, shownOn));
            return BREW_EXIT.onTap;
          }
          if (pullRequests.length > 0) {
            // Only a read of their ends closes the order's issue, and the last line stays the
            // pull requests' (ADR 0261, ADR 0336).
            if (shownOn !== undefined) {
              const claim = now.repo === undefined ? '' : ' and releases its claim';
              say(
                `once they merge, foedrum brew ${shownOn} or foedrum serve closes Brewery issue #${shownOn}${claim}`,
              );
            }
            say(`${said} is on tap: ${pullRequests.join(' ')}`);
            return BREW_EXIT.onTap;
          }
          // With none, what it left instead: a plan's comment (#656).
          const plan = planCommentOf(driver.state(), batchId);
          const shown =
            plan === undefined || shownOn === undefined ? '' : `; the plan: ${commentUrl(plan)}`;
          say(`${said} is on tap: no pull request${shown}`);
          return BREW_EXIT.onTap;
        }
        case 'cancelled':
          if (!released) break;
          // Its release, which this brew came to finish (ADR 0336), and the exit that says cancelled.
          if (ending !== undefined) {
            const issue = shownOn === undefined ? '' : `Brewery issue #${shownOn} stays open, `;
            say(
              `claim on ${now.repo}#${now.issue} released; ${issue}unassign it to make it available`,
            );
          }
          say(`${said} was ${lane} ${detail}`);
          return BREW_EXIT.cancelled;
        case 'stuck': {
          const { reason, options } = now.lane;
          if (reason.kind === 'needs_input') {
            for (const line of questionLines(driver.state(), reason.stepId, now)) say(line);
            return BREW_EXIT.needsInput;
          }
          // The tick that sticks a batch may have decided its revision before: a plan's names no
          // plan comment yet, and a Stuck an action's end records comes after its pass asked what
          // is due. One tick more applies it, and this switch reads what that tick left, so a
          // person's retry meanwhile goes on brewing (ADR 0275, ADR 0330). Questions come only
          // from an attempt's end, which the tick records before it asks.
          const stuck = JSON.stringify(now.lane);
          if (settled !== stuck) {
            settled = stuck;
            continue;
          }
          // A plan to review names its comment, as on tap did before (#656, ADR 0275).
          const plan =
            reason.kind === 'plan_review' ? planCommentOf(driver.state(), batchId) : undefined;
          const shown =
            plan === undefined || shownOn === undefined ? '' : `; the plan: ${commentUrl(plan)}`;
          say(`${said} is stuck: ${detail}; options: ${options.join(', ')}${shown}`);
          if (reason.kind === 'waiting_for_session') {
            say(sessionLine(request.noSessions, driver.state()));
          }
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
      const line = `${said} ${lane}${detail === '' ? '' : `: ${detail}`}`;
      const at = clock().getTime();
      countFromOrder(now);
      noticed(running, at);
      if (line !== shown) {
        shown = line;
        saidAt = at;
        // On tap, the last line says it once its effects are applied (#662).
        if (now.lane.kind !== 'on_tap') say(line);
      } else if (terminal === undefined && running.length > 0 && at - saidAt >= PROGRESS_MS) {
        // A step can run for many minutes in silence: say it still runs (#406).
        saidAt = at;
        const runs = running.map(
          ({ label }) => `${label} running for ${elapsed(at - firstSeen(label, at))}`,
        );
        say(`${said} ${lane}: ${runs.join(', ')}`);
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
    marksEnd.abort();
    await marks;
    clearLive();
    // Closing the driver stops its runs and lets the lock go; a Stuck batch keeps its lease.
    try {
      closeOpened(opened);
    } finally {
      shell.awake?.release();
    }
  }
};
