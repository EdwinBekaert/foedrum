// The status comment of a batch of a Brewery issue (architecture §8, ADR 0072): its text rendered
// from the folded state alone, and its edits as revisions in the ledger, `[batchId, "status.<n>"]`,
// each found by its marker on the Brewery's own comment before it is applied (ADR 0033).

import { passed, settleReadings, shortCommand, testsFailing } from '../checks/gravity.ts';
import type { IsCommit } from '../formats/secrets.ts';
import type {
  CoverageListing,
  GravityReading,
  RoundsOut,
  StuckReason,
  WaitCondition,
} from '../schemas/events.ts';
import { finingOf, gaugeOf, OutDocAssumptions, tastingOf } from '../schemas/out-doc.ts';
import { planOf } from '../schemas/plan.ts';
import { ChosenBy } from '../schemas/recipe.ts';
import type { MergeBrief } from '../schemas/status-comment.ts';
import type { SensitiveFiles } from '../schemas/store.ts';
import {
  type BatchState,
  batchState,
  type DoneHow,
  stateWords,
  waitingWords,
} from './batch-state.ts';
import type { MarkedComment } from './claim-effects.ts';
import { breweryIssueOf, calledAs } from './claim-orders.ts';
import { commentRevisions, cutForComment, type DueRevision } from './comment-revisions.ts';
import type { DriverEffects } from './driver.ts';
import {
  type Attempt,
  type Batch,
  baseChecksOn,
  batchEnded,
  type Input,
  type Pause,
  type State,
  stuckOnFailing,
  type UsageWindows,
} from './fold.ts';
import { handoverLines, handoversOf } from './handover.ts';
import { keptRound } from './lens-rounds.ts';
import { briefLine } from './merge-brief.ts';
import { unreportedLine, unreportedOf } from './named-tests.ts';
import { changesText, issueUrl } from './order-changes.ts';
import { orderEnd, type SubOrderRow, subOrderRows } from './order-end.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { pauseOf, stopAtText } from './pauses.ts';
import { allSubIssues } from './plan-applied.ts';
import { checkPassed } from './pr-checks.ts';
import { type FiledIssue, filedIssues } from './pre-existing-issues.ts';
import {
  changeText,
  digestOf,
  findingText,
  knownCommits,
  latestBody,
  latestPush,
  leftOpenLines,
  openedPullRequest,
  openOf,
  testFirstOffText,
} from './pull-request.ts';
import { type PairConflict, pairsOf } from './pull-request-pairs.ts';
import { receiptParts, receiptsOf } from './receipt.ts';
import type { Recipe, Recipes } from './recipes.ts';
import { resumedAfterOverrun } from './session-resume.ts';
import { stateText } from './sibling-pull-requests.ts';
import { pastBySkip, pastLine } from './skip-past.ts';
import { outDocLink, outDocPlace } from './state-branch.ts';
import { plainReason } from './supervisor.ts';
import { mutantLines } from './survivors.ts';
import { usageWindowsText } from './usage-window.ts';
import { utcMinute } from './wall-clock.ts';

/**
 * What the status comment says of a pull request's merge brief: the current one, or the open pull
 * request that has none (ADR 0229), with the brief of its head that no longer holds (ADR 0350).
 */
export type BriefLine = MergeBrief | { pullRequest: string; held?: MergeBrief };

/** The status comments on the code host, as the Brewery's own identity sees and makes them. */
export interface StatusComments {
  /** The Brewery's own comment on the issue whose body ends with `marker`: its id and body. */
  find(
    repo: string,
    issue: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<{ id: number; body: string } | undefined>;
  /** The body of the comment `comment`, or undefined when it is gone or not the Brewery's own. */
  read(repo: string, comment: number, signal?: AbortSignal): Promise<string | undefined>;
  /** Comments on the issue; the new comment's id. */
  create(repo: string, issue: number, body: MarkedComment, signal?: AbortSignal): Promise<number>;
  /** Replaces the body of `comment`; `gone` when it was deleted. */
  edit(
    repo: string,
    comment: number,
    body: MarkedComment,
    signal?: AbortSignal,
  ): Promise<'edited' | 'gone'>;
}

/** How long a text a brewer or an issue wrote may be in the comment. */
export const longest = 200;
/**
 * How much of such a text is read for secrets (ADR 0088): what can be shown, and room past it for
 * a match that starts there, so a token cut at `longest` is still found whole.
 */
const scanned = 1_000;
/** How many assumptions of one step the comment shows. */
const mostAssumptions = 10;
/** How many questions of a batch Stuck for input the comment shows, and options of each. */
const mostQuestions = 10;
const mostOptions = 10;

/** HTML's characters and `@`, as the entities GitHub shows as themselves. */
const entities: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '@': '&#64;',
};

/** One character as GitHub shows it as itself: Markdown's escaped, the rest of `entities`. */
const shownAsItself = (char: string): string =>
  entities[char] ?? (/[\\`*_[\]#|~!]/.test(char) ? `\\${char}` : char);

/**
 * `text`, which a brewer or an issue wrote, as one line of at most `most` characters that
 * GitHub renders as it is: no Markdown, no HTML (so no marker), and no mention. It is cut after
 * escaping, between characters, so no escape is cut in half and the line never grows past
 * `most`.
 */
export const plainWithin = (text: string, most: number): string => {
  const shown = [...text.replace(/\s+/g, ' ').trim()].map(shownAsItself);
  const whole = shown.join('');
  if (whole.length <= most) return whole;
  let line = '';
  for (const each of shown) {
    if (line.length + each.length > most - 1) break;
    line += each;
  }
  return `${line}…`;
};

/** `text` as `plainWithin` shows it, within the longest a text may be. */
export const plain = (text: string): string => plainWithin(text, longest);

export const code = (id: string): string => `\`${id}\``;

/**
 * What the status comment and `foedrum stuck` recommend when a findings route ran out of rounds,
 * until the analyse recipe can plan the order again itself (ADR 0192, #388).
 */
export const STEP_BACK = 'Another round is unlikely to help: plan the order again, or split it.';

/**
 * What a person does with a plan that waits for its review (ADR 0281): `command` writes a command
 * as the reader shows it.
 */
export const planNextStep = (called: string, command: (text: string) => string): string =>
  `read the plan and its assumptions; sign it off with ${command(`foedrum approve ${called}`)}, correct it in a session with ${command(`foedrum lauter ${called}`)}, plan it again with ${command(`foedrum retry ${called}`)}, or end it with ${command(`foedrum cancel ${called}`)}.`;

/**
 * An option as a line offers it: its name, under a comment that says its number, or the whole command
 * for a batch a number would not reach (ADR 0334).
 */
const optionOffered = (option: string, called: string, batchId: string): string =>
  called === batchId ? `foedrum ${option} ${called}` : option;

/** The options of a plan's review that `planNextStep` names. */
const planCommands: ReadonlySet<string> = new Set(['approve', 'lauter', 'retry', 'cancel']);

/**
 * The text of the `Next:` line of a plan that waits for its review, in the status comment and the
 * plan comment alike: `planNextStep`, then the lane's `options` it does not name (#855).
 */
export const planNextLine = (
  called: string,
  options: readonly string[],
  batchId: string,
): string => {
  const others = options.filter((option) => !planCommands.has(option));
  const also =
    others.length === 0
      ? ''
      : ` Its other ${others.length === 1 ? 'option' : 'options'}: ${others.map((option) => code(optionOffered(option, called, batchId))).join(', ')}.`;
  return `Next: ${planNextStep(called, code)}${also}`;
};

/** `rounds` rounds of a findings route, in words. */
export const roundsText = (rounds: number): string =>
  `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`;

/**
 * A text a brewer wrote at `stepId` as one plain line of at most `most` characters, or a fixed line
 * when it looks like a secret; `cut` shortens a text that does not, before it is escaped.
 */
type Told = (text: string, stepId: string, most?: number, cut?: (text: string) => string) => string;

/** How long an answer is on the path (#656). */
const mostAnswer = 40;
/** How long a failed attempt's reason is on the path (#656). */
const mostReason = 48;

/**
 * `text` without its parenthesised parts, nested ones in them, and the space before each: one pass,
 * so a reason a brewer shaped costs no more than its length. A parenthesis never closed would take
 * the rest with it, so then `text` stays whole.
 */
const withoutParentheses = (text: string): string => {
  let kept = '';
  let depth = 0;
  for (const char of text) {
    if (char === '(') {
      if (depth === 0) kept = kept.trimEnd();
      depth++;
    } else if (char === ')' && depth > 0) depth--;
    else if (depth === 0) kept += char;
  }
  return depth === 0 ? kept : text;
};

/**
 * A failed attempt's reason as the path says it (#656): its first clause, the one the engine starts
 * each reason with, without a parenthesised command when it is too long, cut at a word.
 */
const reasonClause = (reason: string): string => {
  const [clause = reason] = reason.split(': ');
  return clauseWithin(clause);
};

/** A clause within `mostReason`: without a parenthesised part when it is too long, cut at a word. */
const clauseWithin = (clause: string): string => {
  if (clause.length <= mostReason) return clause;
  const bare = withoutParentheses(clause);
  if (bare.length <= mostReason) return bare;
  const cut = bare.slice(0, mostReason - 1);
  const word = cut.lastIndexOf(' ');
  return `${word > 0 ? cut.slice(0, word) : cut}…`;
};

/**
 * A URL as an autolink of its normalized form: the schema keeps the text it was given, and `new URL`
 * encodes the spaces and angle brackets that would let the rest of it render as Markdown.
 */
export const link = (url: string): string => `<${new URL(url).href}>`;

/**
 * A URL behind Foedrum's own `text`, as an out doc's place on the state branch: the URL in angle
 * brackets inside the parentheses, so a `)` or a space in it cannot end the link early.
 */
export const labelled = (text: string, url: string): string => `[${plain(text)}](${link(url)})`;

const waitText = (on: WaitCondition): string => {
  switch (on.kind) {
    case 'merge':
      return `the merge of ${link(on.pullRequest)}`;
    case 'release':
      return `a release of ${plain(on.package)} ${plain(on.minVersion)} or later in ${plain(on.repo)}`;
    case 'sibling':
      return `the batch ${code(on.batchId)}`;
    default:
      return on satisfies never;
  }
};

/**
 * The command that opens the session a batch waits for (ADR 0222): `foedrum brew` of its issue, as
 * `calledAs` names it (ADR 0329), in a terminal, taking the batch from the driver that parked it.
 */
export const sessionCommand = (called: string): string => `foedrum brew ${called} --take`;

const stuckText = (
  reason: StuckReason,
  told: Told,
  called: string,
  { repo, issue }: Batch,
  planComment?: string,
): string => {
  switch (reason.kind) {
    case 'needs_input':
      return `${code(reason.stepId)} needs input`;
    case 'blocked':
      return `${code(reason.stepId)} is blocked (${reason.blockerKind}): ${told(reason.summary, reason.stepId)}`;
    case 'attempts_exhausted':
      return `${code(reason.stepId)} used its ${reason.attempts} attempt${reason.attempts === 1 ? '' : 's'}; the last: ${told(plainReason(reason.lastReason), reason.stepId)}`;
    case 'deadline_passed':
      return `${code(reason.stepId)} passed its deadline of ${reason.deadlineAt}`;
    case 'waiting_for_session':
      return `${code(reason.stepId)} waits for its session: run ${code(sessionCommand(called))} in a terminal (ADR 0222)`;
    // What failed and since when, never blaming the batch: an outage fails it too (ADR 0335).
    case 'failing':
      return `${code(reason.stepId)} could not go on: the ${reason.pass} pass has failed since ${reason.since}: ${told(reason.summary, reason.stepId)}`;
    case 'stalled':
      return `${code(reason.stepId)} stalled: no file written and no commit made since ${reason.lastProgressAt}, for ${reason.turnsWithoutProgress} turns`;
    case 'routing':
      return `no recipe was chosen by its routing deadline, ${reason.deadlineAt}`;
    // A check's name and link are whoever runs CI's words (ADR 0213), shown as plain text and a link.
    case 'pull_request_failed': {
      const after = `after ${roundsText(reason.rounds)}`;
      // The check's name and command are the Brewery's configuration (ADR 0209).
      if (reason.cause !== undefined) {
        // The files are the repository's names (ADR 0244).
        if (reason.cause.kind === 'conflict') {
          const { branch, tip, files } = reason.cause;
          return `${code(reason.stepId)}: ${link(reason.pullRequest)} conflicts with ${code(branch)} at ${code(shortSha(tip))} ${after}: ${files.map(plain).join(', ')}`;
        }
        // A reviewer's login is GitHub's, shown as plain text (ADR 0382).
        if (reason.cause.kind === 'review') {
          const { reviews, more } = reason.cause;
          const asked = reviews.map(({ id, by }) => `review ${id} by ${plain(by)}`);
          const rest = more > 0 ? [`and ${more} more`] : [];
          return `${code(reason.stepId)}: ${link(reason.pullRequest)} got changes asked for on ${code(shortSha(reason.head))} ${after}: ${[...asked, ...rest].join(', ')}`;
        }
        const { branch, tip, check } = reason.cause;
        return `${code(reason.stepId)}: ${link(reason.pullRequest)} fails its checks on the merged tree with ${code(branch)} at ${code(shortSha(tip))} ${after}: ${plain(check)}`;
      }
      const checks = reason.failed.map(
        ({ name, conclusion, url }) =>
          `${plain(name)} (${conclusion})${url === undefined ? '' : ` ${link(url)}`}`,
      );
      const more = reason.more > 0 ? [`and ${reason.more} more`] : [];
      return `${code(reason.stepId)}: ${link(reason.pullRequest)} failed its checks on ${code(reason.head)} ${after}: ${[...checks, ...more].join(', ')}`;
    }
    case 'plan_review': {
      return planComment === undefined
        ? `${code(reason.stepId)} #${reason.attempt}`
        : labelled('plan comment', planComment);
    }
    // Who stopped it and why are a person's words, shown as plain text (ADR 0205).
    case 'stopped': {
      const why = reason.why === undefined ? '' : `: ${plain(reason.why)}`;
      return `at ${code(reason.stepId)}, from the ${reason.via}${why}`;
    }
    // The issue's link and the logins GitHub gave, as plain text (ADR 0368).
    case 'order_changed': {
      const where = labelled(`${repo ?? ''}#${issue}`, issueUrl(repo ?? '', issue));
      const answer = (word: string) => code(`foedrum answer ${called} ${word}`);
      return `${code(reason.stepId)}: ${where} changed after its approval: ${changesText(reason, plain)}. Run ${answer('continue')} to brew it as it is now, or ${answer('stop')} to end the batch`;
    }
    default:
      return reason satisfies never;
  }
};

/**
 * What a findings route that ran out of rounds left open, as the Findings section shows findings,
 * and the recommendation to step back (ADR 0192).
 */
const openLines = (stepId: string, { rounds, open, more }: RoundsOut, told: Told): string[] => {
  const after = roundsText(rounds);
  const listed = open.map(
    (finding) =>
      `- ${code(stepId)}: ${told(findingText(finding), stepId)}: ${told(finding.why, stepId)}`,
  );
  if (more > 0) listed.push(`- ${code(stepId)}: and ${more} more`);
  return [
    ...(listed.length === 0
      ? [`Still open after ${after}: no finding was recorded.`]
      : [`Still open after ${after}:`, ...listed]),
    STEP_BACK,
  ];
};

/** A commit as the comments show it: its first eight digits. */
export const shortSha = (sha: string): string => sha.slice(0, 8);

/**
 * How the pull request `url` of `batch` merges with its base, by its latest check (ADR 0198): the
 * tip and the files of a conflict, or that it merges cleanly again after an earlier conflict; on
 * the merged tree (ADR 0203), the check that failed and how, why the checks did not run, or that
 * they pass again after either; `undefined` when every check was clean or none ran. Only the checks
 * of the head of `open`, the pull request `openOf` reads, when it is `url`: an older head's failure
 * is not this one's (ADR 0226).
 */
const baseCheckLine = (batch: Batch, url: string, open?: OpenPullRequest): string | undefined => {
  const checks = baseChecksOn(batch, url, open?.head);
  const latest = checks.at(-1);
  // An ended pull request is checked no more: its last check says nothing now.
  if (latest === undefined || batch.pullRequestEnds?.[url] !== undefined) return undefined;
  // The branch comes from the Brewery's config; a file's name from whoever committed it.
  const branch = code(latest.branch);
  // Before the filter below: `openOf` passes this pull request over, and this line says why.
  if (latest.branchMoved !== undefined) {
    return `- ${link(url)} is not checked against ${branch} since someone else pushed to its branch`;
  }
  // A pull request `openOf` passes over is checked no more: its last check says nothing now.
  if (url !== open?.url) return undefined;
  const tip = code(shortSha(latest.tip));
  if (latest.conflicts !== undefined) {
    const files = latest.conflicts.map(plain).join(', ');
    return `- ${link(url)} conflicts with ${branch} at ${tip} in ${files}`;
  }
  // The checks on the merged tree (ADR 0203); a reason may quote git's output.
  const merged = `on the merged tree with ${branch}`;
  if (latest.failed !== undefined) {
    return `- ${link(url)} fails ${merged} at ${tip}: ${plain(readingText(latest.failed))}`;
  }
  if (latest.unchecked !== undefined) {
    return `- ${link(url)} is not checked ${merged} at ${tip}: ${plain(latest.unchecked)}`;
  }
  if (checks.some((check) => check.failed !== undefined || check.unchecked !== undefined)) {
    return `- ${link(url)} passes its checks ${merged} again at ${tip}`;
  }
  return checks.some((check) => check.conflicts !== undefined)
    ? `- ${link(url)} merges cleanly with ${branch} again at ${tip}`
    : undefined;
};

/**
 * The check a reading is of, as a reason names it: the setup, a named check with its command, or a
 * literal command. Two readings of the same check name it the same (#526).
 */
export const checkOf = (reading: GravityReading): string => {
  if (reading.result === 'skipped') return `the check "${reading.check}"`;
  if (reading.setup === true) return `the setup "${reading.command}"`;
  return reading.check === undefined
    ? `the check "${reading.command}"`
    : `the check "${reading.check}" (${reading.command})`;
};

/**
 * The check a reading's line is of: a named check by its name alone, the setup or a literal
 * command cut by `shortCommand`, so a long command never cuts off how it ended (#779).
 */
const shortCheckOf = (reading: GravityReading): string => {
  if (reading.result === 'skipped' || reading.check !== undefined) {
    return `the check "${reading.check}"`;
  }
  const command = shortCommand(reading.command);
  return reading.setup === true ? `the setup "${command}"` : `the check "${command}"`;
};

type FailingTests = Extract<GravityReading, { result: 'exited' }>['failing'];

/**
 * The failing tests a reading's line names, their count first, so a line cut at `longest` still
 * says how many failed: `5 tests failing: a, b, …` (ADR 0304).
 */
const failingCount = ({ tests, more }: NonNullable<FailingTests>): string => {
  const names = `${tests.join(', ')}${more === 0 ? '' : ', …'}`;
  return `${testsFailing({ tests, more })}: ${names}`;
};

/**
 * A failed check step's attempt as the path says it when its readings named failing tests: the
 * check and their count, `the check "test" failed, 5 tests failing`, read from the readings, never
 * from the reason (ADR 0307). Only when the readings settle to the reason itself: an attempt that
 * failed for another reason after its checks keeps that reason's clause.
 */
const failingClause = (
  reason: string,
  readings: readonly GravityReading[] = [],
): string | undefined => {
  const settled = settleReadings(readings);
  if (settled.kind !== 'failed' || settled.reason !== reason) return undefined;
  const decisive = readings.find((reading) => !passed(reading));
  if (decisive?.result !== 'exited' || decisive.failing === undefined) return undefined;
  return `${shortCheckOf(decisive)} failed, ${testsFailing(decisive.failing)}`;
};

/**
 * A reading that did not pass, as its line in a comment says it: a named check by its name alone,
 * unlike a check step's reason (`checkOf`, ADR 0069, ADR 0140), then how it ended and the failing
 * tests its reports named (ADR 0304).
 */
export const readingText = (reading: GravityReading): string => {
  const what = shortCheckOf(reading);
  switch (reading.result) {
    case 'skipped':
      return `${what} was skipped`;
    case 'exited': {
      const failed = `${what} failed with exit code ${reading.exitCode}`;
      return reading.failing === undefined ? failed : `${failed}, ${failingCount(reading.failing)}`;
    }
    case 'signaled':
      return `${what} was ended by ${reading.signal}`;
    case 'unstarted':
      return `${what} could not start`;
    case 'killed':
      switch (reading.killed) {
        case 'timed-out':
          return `${what} did not finish by its deadline`;
        case 'too-much-output':
          return `${what} wrote more output than the process runner's limit`;
        case 'stopped':
          return `${what} was stopped`;
        default: {
          const unhandled: never = reading.killed;
          throw new Error(`Unhandled kill ${JSON.stringify(unhandled)}`);
        }
      }
    default: {
      const unhandled: never = reading;
      throw new Error(`Unhandled reading ${JSON.stringify(unhandled)}`);
    }
  }
};

/** A conflict of two open pull requests' heads (ADR 0230); a file's name is whoever committed it. */
const pairLine = ({ pullRequest, other, conflicts }: PairConflict): string =>
  `- ${link(pullRequest)} conflicts with the open pull request ${link(other)} in ${conflicts.map(plain).join(', ')}`;

/** The pull request of a batch that `openOf` reads, and the commit its latest push recorded. */
type OpenPullRequest = { url: string; head: string };

/** The lines of the pull requests of a batch on tap that its base checks have something to say of. */
export const baseCheckLines = (state: State, batch: Batch): string[] => {
  const open = openOf(state, batch);
  return batch.lane.kind === 'on_tap'
    ? batch.lane.pullRequests.flatMap((url) => baseCheckLine(batch, url, open) ?? [])
    : [];
};

/**
 * The line of the open pull request of a batch on tap whose checks on its head were recorded
 * (ADR 0213): waiting for them since when, passed, failed with a link to a failing one, or none.
 */
export const checkLines = (state: State, batch: Batch): string[] =>
  openCheckLines(batch, openOf(state, batch));

/** The check line of `open`, the pull request `openOf` reads: no other is read any more. */
const openCheckLines = (batch: Batch, open?: OpenPullRequest): string[] => {
  const line = open === undefined ? undefined : checkLine(batch, open.url);
  return line === undefined ? [] : [line];
};

/** What the latest record of the checks on the head of the pull request `url` says (ADR 0213). */
const checkLine = (batch: Batch, url: string): string | undefined => {
  const record = batch.pullRequestChecks?.[url];
  if (record === undefined) return undefined;
  const head = code(shortSha(record.head));
  if (record.kind === 'pending') {
    return `- ${link(url)} waits for its checks on ${head} since ${record.since}`;
  }
  if (record.checks.length === 0) return `- ${link(url)} has no checks on ${head}`;
  const failed = record.checks.filter(({ conclusion }) => !checkPassed(conclusion));
  // The first failing check with a link, else the first; its name comes from whoever runs CI.
  const named = failed.find((check) => check.url !== undefined) ?? failed[0];
  if (named === undefined) return `- ${link(url)} passed its checks on ${head}`;
  const at = named.url === undefined ? '' : ` ${link(named.url)}`;
  // Failed checks are kept first: when every kept one failed, some left out may have failed too.
  const atLeast = failed.length === record.checks.length && record.more !== undefined;
  const more =
    failed.length > 1 ? `, and ${atLeast ? 'at least ' : ''}${failed.length - 1} more` : '';
  return `- ${link(url)} failed its checks on ${head}: ${plain(named.name)} (${named.conclusion})${at}${more}`;
};

/**
 * A sub-order of the batch's order: its pull request by its state, and the release after its
 * merge (ADR 0292); before it has one, its state (ADR 0385), or that its plan entry needs refinement (ADR 0293).
 */
const subOrderPullLine = (row: SubOrderRow): string => {
  const { subOrder, repo, pullRequest, state, now, release, left } = row;
  const where = `- #${subOrder} in ${plain(repo)}`;
  if (pullRequest === undefined) {
    if (now !== undefined) return `${where}: ${stateWords[now.kind]}, no pull request yet`;
    return `${where}: ${left === 'needs refinement' ? left : 'not ordered yet'}`;
  }
  const at = release?.url === undefined ? '' : ` ${link(release.url)}`;
  const releasedAs = release === undefined ? '' : `, released as ${plain(release.version)}${at}`;
  return `${where}: ${link(pullRequest)}, ${stateText[state]}${releasedAs}`;
};

/**
 * Which of the order's sub-orders keep it open and why (ADR 0293); a done order says so on its
 * state line (ADR 0385).
 */
const orderEndLines = (rows: readonly SubOrderRow[]): string[] => {
  const end = orderEnd(rows);
  if (end === undefined || end.kind === 'done' || end.left.length === 0) return [];
  const named = end.left.map(({ subOrder, why }) => `#${subOrder} (${why})`);
  return [`Keeps the order open: ${named.join(', ')}`];
};

/** Issue `numbers` as `#1, #2`. */
export const issueNumbers = (numbers: readonly number[]): string =>
  numbers.map((number) => `#${number}`).join(', ');

/** A batch's mark, in a lane it changes nothing in (ADR 0335); a Stuck reason on it says it itself. */
const failingLines = ({ failing, lane }: Batch, told: Told): string[] =>
  failing === undefined || stuckOnFailing(lane)
    ? []
    : [
        `⚠️ **Failing**: the ${failing.pass} pass has failed since ${failing.since}: ${told(failing.summary, '')}`,
      ];

/** A state's own words as a comment's line starts them, in bold: `**Waiting for you**`. */
const stateHead = (state: BatchState): string => {
  const words = stateWords[state.kind];
  return `**${words.charAt(0).toUpperCase()}${words.slice(1)}**`;
};

/**
 * The batch's state (ADR 0385), and what it waits for or how it ended; for Stuck why. Never a
 * reminder's time, which changes alone. The mark follows the state (🔔 for a person's action).
 */
const laneText = (
  batch: Batch,
  told: Told,
  called: string,
  planComment?: string,
  subIssues?: readonly number[],
  rows: readonly SubOrderRow[] = [],
): string[] => {
  const { lane } = batch;
  const state = batchState(batch, rows);
  const head = stateHead(state);
  switch (lane.kind) {
    case 'ordered':
      return [`📥 ${head}: waiting for a recipe`];
    case 'brewing':
      return [`🍺 ${head}`];
    case 'conditioning':
      return [`⏳ ${head}: waiting for ${waitText(lane.on)}`];
    case 'stuck': {
      const { reason } = lane;
      const asked = reason.kind === 'needs_input' ? reason.questions : [];
      const tell = (text: string): string =>
        told(text, reason.kind === 'needs_input' ? reason.stepId : '');
      const questions = asked.slice(0, mostQuestions).map((question) => {
        const options = question.options.slice(0, mostOptions).map(tell);
        const more = question.options.length - options.length;
        if (more > 0) options.push(`and ${more} more options`);
        return `- ${tell(question.q)} Options: ${options.join(', ')} (recommended: ${tell(question.recommended)})`;
      });
      if (asked.length > questions.length) {
        questions.push(`- and ${asked.length - questions.length} more questions`);
      }
      const what = state.kind === 'waiting' ? waitingWords(state.for, plain) : '';
      return [
        `🔔 ${head}: ${what}: ${stuckText(reason, told, called, batch, planComment)}`,
        ...questions,
        ...(reason.kind === 'blocked' && reason.roundsOut !== undefined
          ? openLines(reason.stepId, reason.roundsOut, told)
          : []),
      ];
    }
    case 'on_tap': {
      // A plan a person signed off is on tap with no pull request (ADR 0281).
      const { approval } = batch;
      const approved =
        approval === undefined ? [] : [`plan approved by ${plain(approval.by)} (${approval.via})`];
      switch (state.kind) {
        case 'waiting':
          return [`🔔 ${head}: ${waitingWords(state.for, plain)}`];
        case 'running': {
          const numbers = (state.subOrders?.length ?? 0) > 0 ? state.subOrders : subIssues;
          const named =
            numbers === undefined || numbers.length === 0 ? '' : ` (${issueNumbers(numbers)})`;
          return [`🍺 ${head}: ${[`the sub-orders brew${named}`, ...approved].join('; ')}`];
        }
        case 'done':
          return [`🍻 ${head}: ${doneWords(state.how)}`];
        // batchState never queues an on-tap batch: shown as it would be, never thrown.
        case 'queued':
          return [`📥 ${head}`];
        default:
          return state satisfies never;
      }
    }
    case 'cancelled':
      return [`🚫 ${head}: ${doneWords({ kind: 'cancelled', by: lane.by, via: lane.via })}`];
    default:
      return lane satisfies never;
  }
};

/** How an on-tap batch ended, in the comment's words. */
const doneWords = (how: DoneHow): string => {
  switch (how.kind) {
    case 'pull_requests':
      return [
        ...(how.merged.length === 0 ? [] : [`merged ${how.merged.map(link).join(', ')}`]),
        ...(how.closed.length === 0
          ? []
          : [`closed without merging ${how.closed.map(link).join(', ')}`]),
      ].join('; ');
    case 'sub_orders':
      return 'every sub-order merged';
    case 'no_pull_request':
      return 'no pull request';
    case 'cancelled':
      return `cancelled by ${plain(how.by)} (${how.via})`;
    default:
      return how satisfies never;
  }
};

/**
 * What the person does next, while the batch waits on them or hands its work over (ADR 0316): the
 * last line of the comment's first block, which a cut never drops. None while nothing waits on
 * them: the batch brews, or its pull requests and its order ended.
 */
const nextLines = (
  batch: Batch,
  subIssues: readonly number[] | undefined,
  rows: readonly SubOrderRow[],
  called: string,
  brief?: BriefLine,
  open?: OpenPullRequest,
): string[] => {
  const { lane } = batch;
  if (lane.kind === 'stuck') {
    const { reason, options } = lane;
    const moving = (shown: readonly string[]): string =>
      `get it moving with ${shown.map((option) => code(optionOffered(option, called, batch.id))).join(', ')}`;
    switch (reason.kind) {
      // What to do with a plan that waits for its review (ADR 0275, ADR 0281).
      case 'plan_review':
        return [planNextLine(called, options, batch.id)];
      case 'needs_input': {
        const answers = reason.questions.map((_, n) => `<answer ${n + 1}>`).join(' ');
        const others = options.filter((option) => option !== 'answer');
        const or = others.length === 0 ? '' : `, or ${moving(others)}`;
        return [
          `Next: answer the questions above with ${code(`foedrum answer ${called} ${answers}`)}${or}.`,
        ];
      }
      // The one question of an issue that changed since its approval (ADR 0368).
      case 'order_changed': {
        const answer = (word: string) => code(`foedrum answer ${called} ${word}`);
        return [
          `Next: answer with ${answer('continue')} to brew the issue as it is now, or ${answer('stop')} to end the batch.`,
        ];
      }
      default:
        return [`Next: ${moving(options)}.`];
    }
  }
  if (lane.kind !== 'on_tap') return [];
  const unended = lane.pullRequests.filter((url) => batch.pullRequestEnds?.[url] === undefined);
  if (unended.length > 0) return [`Next: ${pullRequestsNext(unended, brief, open)}.`];
  // A split order hands its work to its sub-orders (ADR 0293).
  if (lane.pullRequests.length > 0 || (batch.approval === undefined && rows.length === 0)) {
    return [];
  }
  const end = orderEnd(rows);
  if (end?.kind === 'done') return [];
  if (end !== undefined && end.left.length > 0) {
    return [
      `Next: see to what keeps the order open (${issueNumbers(end.left.map(({ subOrder }) => subOrder))}).`,
    ];
  }
  const numbers = rows.length > 0 ? rows.map(({ subOrder }) => subOrder) : (subIssues ?? []);
  const named = numbers.length === 0 ? '' : ` (${issueNumbers(numbers)})`;
  return [
    `Next: nothing to do; the sub-orders brew${named}, and each pull request comes to you to merge.`,
  ];
};

/**
 * What the person does with each open pull request (ADR 0350): review and merge those whose merge
 * brief is current, which are ready for review; wait for the brief of the one Foedrum follows
 * (`openOf`); and, of one it follows no more (someone else pushed to it, or its own latest push
 * pushed nothing), merge it without a brief or mark it ready.
 */
const pullRequestsNext = (
  urls: readonly string[],
  brief: BriefLine | undefined,
  open: OpenPullRequest | undefined,
): string => {
  const briefed = urls.filter((url) => brief?.pullRequest === url && 'comment' in brief);
  const others = urls.flatMap((url) => {
    if (briefed.includes(url)) return [];
    if (open?.url === url) {
      return [
        `wait for ${link(url)}'s merge brief: it comes once ${code('foedrum serve')} reads its checks passed on ${code(shortSha(open.head))}`,
      ];
    }
    return [
      `Foedrum follows ${link(url)} no more: review and merge it without a merge brief, or mark it ready yourself`,
    ];
  });
  const merge = briefed.length === 0 ? [] : [`review and merge ${briefed.map(link).join(', ')}`];
  return [...merge, ...others].join('; ');
};

/**
 * What a batch on tap with a plan and no pull request says: the plan comment shows it (ADR 0234).
 * A batch is on tap with one when a person approved it (ADR 0281), or when it was recorded before
 * a plan waited Stuck for its review (ADR 0275).
 */
const PLANNED =
  'No pull request: the plan is in its own comment on this issue, and nothing is built from it yet.';

/** What a split order's batch on tap says: its sub-orders' pull requests are its work (ADR 0293). */
const SPLIT = "No pull request of its own: its sub-orders' are listed above.";

/** Whether an attempt of `batch` succeeded with a plan (ADR 0233). */
const planned = (batch: Batch): boolean =>
  [...batch.steps.values()].some((step) =>
    [...step.attempts.values()].some(
      (attempt) =>
        attempt.phase === 'finished' &&
        attempt.outcome.kind === 'succeeded' &&
        planOf(attempt.outcome.output) !== undefined,
    ),
  );

/** Who paused the batch, from where and why, and when what still runs is stopped (ADR 0202). */
const pauseText = ({ by, via, why, stopAt }: Pause): string => {
  const reason = why === undefined ? '' : `: ${plain(why)}`;
  const stopped =
    stopAt === undefined ? '' : `, and what still runs at ${plain(stopAtText(stopAt))} is stopped`;
  return `⏸️ **Paused** by ${plain(by)} (${via})${reason}. Nothing new starts; what runs ends at its next convenient point${stopped}.`;
};

/** What a brewing batch shows while a usage window is closed, a line each (ADR 0206, ADR 0215). */
const usageWindowLines = (batch: Batch, windows: UsageWindows): string[] =>
  batch.lane.kind !== 'brewing'
    ? []
    : usageWindowsText(windows).map((text) => `⏳ ${plain(text)}.`);

const recipeText = (recipe: Batch['recipe']): string => {
  if (recipe === undefined) return 'No recipe is chosen yet.';
  const name = `Recipe **${plain(recipe.name)}**`;
  switch (recipe.source) {
    case 'label':
      return `${name}, chosen by the issue's ${code(`recipe:${recipe.name}`)} label`;
    case 'router':
      return `${name}, chosen by the router: ${plain(recipe.reason)}`;
    case 'human':
      // The reason a person gave, which foedrum recipe asks for (ADR 0355).
      return `${name}, chosen by ${plain(recipe.by)} (${recipe.via}): ${plain(recipe.reason)}`;
    default:
      return recipe satisfies never;
  }
};

/** What the comment says of an attempt that resumed after a turn overrun (ADR 0175). */
const afterTheBudget = 'resumed after the turn budget';

/** The attempts of a step, latest first. */
const latestFirst = (batch: Batch, stepId: string): Attempt[] =>
  [...(batch.steps.get(stepId)?.attempts.values() ?? [])].sort((a, b) => b.attempt - a.attempt);

/** The latest answer to the questions attempt `n` of `stepId` asked, if one came (#656). */
const answerOf = (batch: Batch, stepId: string, n: number): Input | undefined =>
  batch.steps
    .get(stepId)
    ?.inputs.filter(({ attempt }) => attempt === n)
    .at(-1);

/** The answers of `input`, on one line. */
const answersText = (input: Input): string => input.answers.map(({ answer }) => answer).join(', ');

/**
 * The step a Stuck batch stopped at, whose latest attempt the step list and the path mark Stuck;
 * none for a plan to review, whose attempt succeeded (ADR 0275).
 */
const stuckStep = ({ lane }: Batch): string | undefined =>
  lane.kind === 'stuck' && 'stepId' in lane.reason && lane.reason.kind !== 'plan_review'
    ? lane.reason.stepId
    : undefined;

/**
 * The out doc of the attempt `attempt` of `stepId` on `stateBranchUrl`: a plan's as GitHub renders
 * it, since its body reads (ADR 0275), any other's as written; on a step's line named by its file
 * alone, since the comment is the batch's (ADR 0386).
 */
const outDocLabelled = (
  batch: Batch,
  stepId: string,
  done: { attempt: number; output: unknown },
  stateBranchUrl: string,
  fileOnly = false,
): string => {
  const ref = { batchId: batch.id, stepId, attempt: done.attempt };
  const place = outDocPlace(ref);
  return labelled(
    fileOnly ? place.slice(`${batch.id}/`.length) : place,
    outDocLink(stateBranchUrl, ref, planOf(done.output) !== undefined),
  );
};

const stepLine = (batch: Batch, stepId: string, told: Told, stateBranchUrl?: string): string => {
  const id = code(stepId);
  if (batch.skipped?.has(stepId) === true) {
    // Every `when` the engine follows reads recipe.testFirst, so a skip of a batch whose plan
    // turned test-first off is that plan's (ADR 0064, ADR 0371).
    const { testFirstOff, plan } = batch;
    return testFirstOff === undefined || plan === undefined
      ? `- ⏭️ ${id}: skipped`
      : `- ⏭️ ${id}: skipped: ${testFirstOffText(told(testFirstOff, plan.stepId))}`;
  }
  const [latest] = latestFirst(batch, stepId);
  if (latest === undefined) return `- ⬜ ${id}: not run yet`;
  const n = latest.attempt;
  if (stuckStep(batch) === stepId) return `- 🔔 ${id}: stuck at attempt ${n}`;
  if (latest.phase !== 'finished') {
    if (latest.abandoned === true) return `- ⏹️ ${id}: attempt ${n} stopped`;
    // A person's open session has no deadline: the comment says since when it waits (ADR 0222).
    if (latest.phase === 'started' && latest.interactiveSince !== undefined) {
      return `- ▶️ ${id}: session open since ${utcMinute(latest.interactiveSince)}, attempt ${n}`;
    }
    const resumed = resumedAfterOverrun(batch, { batchId: batch.id, stepId, attempt: n });
    return `- ▶️ ${id}: brewing, attempt ${n}${resumed ? `, ${afterTheBudget}` : ''}`;
  }
  const { outcome } = latest;
  switch (outcome.kind) {
    // The out doc the step's line sums up, linked (ADR 0275): a check step and an action, as
    // openPullRequest, write none, and every out doc has its assumptions.
    case 'succeeded': {
      // A Taster's approval its group did not run again after a round back (ADR 0357).
      const round = keptRound(batch, stepId);
      const ran = round === undefined ? id : `${id}, from round ${round}`;
      return stateBranchUrl === undefined || !OutDocAssumptions.safeParse(outcome.output).success
        ? `- ✅ ${ran}: done`
        : `- ✅ ${ran}: done, its report: ${outDocLabelled(batch, stepId, { attempt: n, output: outcome.output }, stateBranchUrl, true)}`;
    }
    case 'failed':
      return `- ❌ ${id}: attempt ${n} failed: ${told(plainReason(outcome.reason), stepId)}`;
    case 'needs_input': {
      const asked = `- ❓ ${id}: attempt ${n} asked for input`;
      const input = answerOf(batch, stepId, n);
      if (input === undefined) return asked;
      const { by, via } = input;
      return `${asked}, answered by ${plain(by)} (${via}): ${told(answersText(input), stepId)}`;
    }
    case 'cancelled':
      return `- ⏹️ ${id}: attempt ${n} stopped`;
    default:
      return outcome satisfies never;
  }
};

/**
 * What the uncovered-line check of a check step's latest finished attempt did not measure, under the
 * step's line (ADR 0274): changed code no test loaded, changed files outside every code area, and
 * the modules with `coverage: none` it skipped.
 */
const coverageLines = (batch: Batch, stepId: string, told: Told): string[] => {
  const latest = latestFirst(batch, stepId).find((attempt) => attempt.phase === 'finished');
  const listing = latest?.phase === 'finished' ? latest.coverage : undefined;
  if (listing === undefined) return [];
  const files = (what: string, listed: CoverageListing['notLoaded']): string[] =>
    listed === undefined
      ? []
      : [
          `  - ${what}: ${listed.files.map((file) => told(file, stepId)).join(', ')}${listed.more > 0 ? ` and ${listed.more} more` : ''}`,
        ];
  return [
    ...files('not loaded by any test', listing.notLoaded),
    ...files('no executable lines in any report', listing.noLines),
    ...files('outside every code area', listing.outside),
    ...(listing.unmeasured === undefined
      ? []
      : [`  - not measured, coverage none: ${listing.unmeasured.map(plain).join(', ')}`]),
  ];
};

/** How attempt `n` of `stepId` stands, as the step list marks it. */
const markOf = (batch: Batch, stepId: string, n: number): string => {
  const attempt = batch.steps.get(stepId)?.attempts.get(n);
  const latest = latestFirst(batch, stepId)[0]?.attempt;
  if (stuckStep(batch) === stepId && latest === n) return '🔔';
  if (attempt === undefined || attempt.phase !== 'finished') {
    return attempt?.abandoned === true ? '⏹️' : '▶️';
  }
  switch (attempt.outcome.kind) {
    case 'succeeded':
      return '✅';
    case 'failed':
      return '❌';
    case 'needs_input':
      return '❓';
    case 'cancelled':
      return '⏹️';
    default:
      return attempt.outcome satisfies never;
  }
};

/** What the path's first line starts with, for a person who hasn't followed the batch (ADR 0386). */
const pathHead = 'Steps run, in order (#n is the nth try of a step): ';

/**
 * The batch's attempts in the order they ran, each marked, a line per round; none before its
 * first. Each is a code span: GitHub would link a bare `#1` to issue 1.
 */
const pathLines = (batch: Batch, told: Told): string[] => {
  const { path = [] } = batch;
  // Stuck at an attempt that never started: the path ends there all the same.
  const stuckAt = stuckStep(batch);
  const latest = stuckAt === undefined ? undefined : latestFirst(batch, stuckAt)[0]?.attempt;
  const onPath = path.some((each) => each.stepId === stuckAt && each.attempt === latest);
  const all =
    stuckAt === undefined || latest === undefined || onPath
      ? path
      : [...path, { stepId: stuckAt, attempt: latest }];
  if (all.length === 0) return [];
  const shown = all.map(({ stepId, attempt }) => {
    const mark = `${code(`${stepId} #${attempt}`)} ${markOf(batch, stepId, attempt)}`;
    const ended = batch.steps.get(stepId)?.attempts.get(attempt);
    if (ended?.phase !== 'finished' || mark.endsWith('🔔')) return mark;
    const { outcome } = ended;
    // Why a failed attempt failed, so a retry does not read as the step failing (#656).
    if (outcome.kind === 'failed') {
      const counted = failingClause(outcome.reason, ended.readings);
      return counted === undefined
        ? `${mark} ${told(outcome.reason, stepId, longest, reasonClause)}`
        : `${mark} ${told(counted, stepId, longest, clauseWithin)}`;
    }
    const input = outcome.kind === 'needs_input' ? answerOf(batch, stepId, attempt) : undefined;
    if (input === undefined) return mark;
    const answer = told(answersText(input), stepId, mostAnswer);
    return `${mark} → ${answer} (by ${plain(input.by)} via ${input.via})`;
  });
  // An attempt a route scheduled starts a line, a round of its own; the attempts one route
  // scheduled together share it (ADR 0272).
  const rounds: string[][] = [];
  let routeBefore: string | undefined;
  for (const [n, { stepId, attempt }] of all.entries()) {
    const route = batch.steps.get(stepId)?.attempts.get(attempt)?.route;
    const routed = route === undefined ? undefined : JSON.stringify(route);
    if (n === 0 || (routed !== undefined && routed !== routeBefore)) rounds.push([]);
    rounds.at(-1)?.push(shown[n] ?? '');
    routeBefore = routed;
  }
  return rounds.map((round, n) => `${n === 0 ? pathHead : '→ '}${round.join(' → ')}`);
};

/** The number and output of the latest attempt of `stepId` that succeeded; else undefined. */
const latestSucceeded = (
  batch: Batch,
  stepId: string,
): { attempt: number; output: unknown } | undefined => {
  for (const attempt of latestFirst(batch, stepId)) {
    if (attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded') {
      return { attempt: attempt.attempt, output: attempt.outcome.output };
    }
  }
  return undefined;
};

/** The assumptions of the latest out doc of `stepId` that succeeded. */
const assumptionsOf = (batch: Batch, stepId: string, told: Told): string[] => {
  const done = latestSucceeded(batch, stepId);
  if (done === undefined) return [];
  const parsed = OutDocAssumptions.safeParse(done.output);
  if (!parsed.success) return [];
  return parsed.data.assumptions.map((text) => told(text, stepId)).filter((text) => text !== '');
};

/** The first `most` of `all` as lines of `stepId`, and a line that counts the rest, as `rest`. */
export const capped = <T>(
  stepId: string,
  all: readonly T[],
  most: number,
  text: (item: T) => string,
  rest = '',
): string[] => {
  const shown = all.slice(0, most).map((item) => `- ${code(stepId)}: ${text(item)}`);
  const more = all.length - shown.length;
  return more > 0 ? [...shown, `- ${code(stepId)}: and ${more} more${rest}`] : shown;
};

/**
 * The out doc of the latest attempt of `stepId` that succeeded, on `stateBranchUrl`, when it is a
 * plan: where its assumptions read whole (ADR 0266), and the plan comment that shows its
 * sub-orders (ADR 0275).
 */
const fullPlanLine = (
  batch: Batch,
  stepId: string,
  stateBranchUrl?: string,
  planComment?: string,
): string[] => {
  if (stateBranchUrl === undefined) return [];
  const done = latestSucceeded(batch, stepId);
  if (done === undefined || planOf(done.output) === undefined) return [];
  const shown = planComment === undefined ? '' : `; ${labelled('plan comment', planComment)}`;
  return [
    `- ${code(stepId)}: full plan: ${outDocLabelled(batch, stepId, done, stateBranchUrl)}${shown}`,
  ];
};

/** The longest summary of a plan's assumption, before its `…` (ADR 0275). */
const summaryLength = 120;

/**
 * An assumption of a plan as the status comment sums it up (ADR 0275): its first sentence, cut at
 * the last word that fits in `summaryLength`, its full text behind the plan's link. A sentence
 * ends at `.`, `!` or `?` before a blank or the end.
 */
const summaryOf = (text: string): string => {
  const end = text.search(/[.!?](?:\s|$)/);
  const sentence = end < 0 ? text : text.slice(0, end + 1);
  if (sentence.length <= summaryLength) return sentence;
  const kept = sentence.slice(0, summaryLength);
  const word = kept.lastIndexOf(' ');
  return `${word > 0 ? kept.slice(0, word) : kept}…`;
};

const assumptionLines = (
  batch: Batch,
  stepIds: readonly string[],
  told: Told,
  stateBranchUrl?: string,
  planComment?: string,
): string[] =>
  stepIds.flatMap((stepId) => {
    // A plan's assumptions are summed up, each whole in its out doc (ADR 0275).
    const summed: Told =
      planOf(latestSucceeded(batch, stepId)?.output) === undefined
        ? told
        : (text, of, most) => told(text, of, most, summaryOf);
    const shown = capped(
      stepId,
      assumptionsOf(batch, stepId, summed),
      mostAssumptions,
      (text) => text,
    );
    return shown.length === 0
      ? []
      : [...shown, ...fullPlanLine(batch, stepId, stateBranchUrl, planComment)];
  });

/** The latest finished attempt of `stepId` when it succeeded; else undefined. */
const latestSucceededAttempt = (batch: Batch, stepId: string) => {
  const finished = latestFirst(batch, stepId).find((attempt) => attempt.phase === 'finished');
  return finished?.phase === 'finished' && finished.outcome.kind === 'succeeded'
    ? finished
    : undefined;
};

/** The output of `stepId`'s latest finished attempt when it succeeded; else undefined. */
const latestOutput = (batch: Batch, stepId: string): unknown => {
  const finished = latestSucceededAttempt(batch, stepId);
  return finished?.outcome.kind === 'succeeded' ? finished.outcome.output : undefined;
};

/** How many of a step's new tests, and of its regression tests, the comment shows. */
const mostTests = 10;

/**
 * The new tests and the regression tests the latest out doc of each step that succeeded named
 * (ADR 0170), the new ones first, at most `mostTests` of each kind with a count of the rest.
 */
const testLines = (batch: Batch, stepIds: readonly string[], told: Told): string[] =>
  stepIds.flatMap((stepId) => {
    const done = latestSucceeded(batch, stepId);
    const named = done === undefined ? undefined : gaugeOf(done.output);
    if (named === undefined) return [];
    const kind = (names: readonly string[], what: string): string[] =>
      capped(stepId, names, mostTests, (name) => `${what}: ${told(name, stepId)}`, ` ${what}s`);
    return [...kind(named.tests, 'new test'), ...kind(named.regressionTests, 'regression test')];
  });

/** How many findings of one Taster's step the comment shows. */
const mostFindings = 10;

/**
 * What a person's skip went past (ADR 0345): each step that did not pass, and the findings the latest
 * round of one blocked by them recorded, as the merge brief lists them.
 */
const pastSkipLines = (batch: Batch, told: Told): string[] =>
  pastBySkip(batch).flatMap((past) => [
    `- ${pastLine(past)}`,
    ...leftOpenLines(past.stepId, past.attempt, told, mostFindings),
  ]);

/**
 * The findings of each Taster's step whose latest finished attempt succeeded (ADR 0161): a blocking
 * verdict ends its attempt blocked, and an earlier round's findings are no longer current. A step of
 * several lenses together shows `mostFindings` of each lens, as its lenses apart would (ADR 0220):
 * its schema has every finding name one of the step's lenses, which bounds the groups. Any other
 * step shows `mostFindings` in all.
 */
const findingLines = (batch: Batch, stepIds: readonly string[], told: Told): string[] =>
  stepIds.flatMap((stepId) => {
    const findings = tastingOf(latestOutput(batch, stepId))?.findings ?? [];
    const named = findings.every(({ lens }) => lens !== undefined);
    const byLens = named
      ? Map.groupBy(findings, ({ lens }) => lens)
      : new Map([[undefined, findings]]);
    return [...byLens].flatMap(([lens, findings]) =>
      capped(
        stepId,
        findings,
        mostFindings,
        (finding) => `${told(findingText(finding), stepId)}: ${told(finding.why, stepId)}`,
        lens === undefined ? '' : ` of ${lens}`,
      ),
    );
  });

/**
 * Each confirmed survivor of a Brett step whose latest finished attempt succeeded, where it is, its
 * edit and the bug it plants, and how many mutants had each verdict (ADR 0319): a blocking step's
 * survivors end its attempt blocked, as a Taster's findings do.
 */
const survivorLines = (batch: Batch, stepIds: readonly string[], told: Told): string[] =>
  stepIds.flatMap((stepId) =>
    mutantLines(latestSucceededAttempt(batch, stepId)?.mutants ?? [], (text) =>
      told(text, stepId),
    ).map((line) => `- ${code(stepId)}: ${line}`),
  );

/** How many items of one Taster's risk left the comment shows. */
const mostRisksLeft = 5;

/** The risk left each Taster's step wrote in its latest round, as its findings are (ADR 0214). */
const riskLeftLines = (batch: Batch, stepIds: readonly string[], told: Told): string[] =>
  stepIds.flatMap((stepId) =>
    capped(stepId, tastingOf(latestOutput(batch, stepId))?.riskLeft ?? [], mostRisksLeft, (risk) =>
      told(risk, stepId),
    ),
  );

/** How many changes of one Finer's step the comment shows. */
const mostChanges = 10;

/**
 * The changes of each Finer's step whose latest finished attempt succeeded, or why it had nothing
 * to simplify (ADR 0166), as the findings are shown.
 */
const simplificationLines = (batch: Batch, stepIds: readonly string[], told: Told): string[] =>
  stepIds.flatMap((stepId) => {
    const fining = finingOf(latestOutput(batch, stepId));
    if (fining?.unchanged !== undefined) {
      return [`- ${code(stepId)}: nothing to simplify: ${told(fining.unchanged, stepId)}`];
    }
    return capped(
      stepId,
      fining?.changes ?? [],
      mostChanges,
      (change) => `${told(changeText(change), stepId)}: ${told(change.why, stepId)}`,
    );
  });

/** How many receipt lines the comment shows. */
const mostReceipts = 30;

/**
 * One line per attempt with a receipt, in the order they ran (ADR 0172). A tool's name and a
 * refused prefix came from the stream, so they are told as a brewer's text.
 */
const receiptLines = (batch: Batch, told: Told): string[] => {
  const all = receiptsOf(batch);
  const shown = all
    .slice(0, mostReceipts)
    .map(({ stepId, attempt, receipt, usage }) =>
      [
        `- ${code(`${stepId} #${attempt}`)}`,
        ...receiptParts(receipt, usage, (text) => told(text, stepId)),
        ...(resumedAfterOverrun(batch, { batchId: batch.id, stepId, attempt })
          ? [afterTheBudget]
          : []),
      ].join(' · '),
    );
  const more = all.length - shown.length;
  return more > 0 ? [...shown, `- and ${more} more`] : shown;
};

/** How many of the sensitive files a batch's change touches the comment names. */
const mostSensitive = 10;

/**
 * The sensitive files the push of a batch's pull request recorded (ADR 0201), as one line: the
 * first `mostSensitive`, each as a committer named it, and a count of the rest.
 */
export const sensitiveLine = (sensitive: SensitiveFiles): string => {
  const named = sensitive.files.slice(0, mostSensitive).map(plain);
  const more = sensitive.count - named.length;
  return `Touches sensitive paths: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

/**
 * For each repository of the batch, the test map its latest check that ran the tests found stale
 * without failing for it, one line each, or none (ADR 0282): the Brewery's, which a batch cannot
 * change, or one only a person's change can refresh.
 */
const staleMapLines = (batch: Batch): string[] => {
  // The repositories, in lower case as GitHub's names are, whose latest run is read.
  const read = new Set<string>();
  const lines: string[] = [];
  for (const { stepId, attempt } of [...(batch.path ?? [])].reverse()) {
    const ran = batch.steps.get(stepId)?.attempts.get(attempt);
    if (ran?.phase !== 'finished') continue;
    const { staleMap } = ran;
    const repo = staleMap?.repo ?? ran.worktree?.repo;
    if (repo === undefined || read.has(repo.toLowerCase())) continue;
    if (staleMap !== undefined) {
      const whose = staleMap.kept === 'brewery' ? "The Brewery's test map" : 'The test map';
      const more = staleMap.more > 0 ? ` and ${staleMap.more} more` : '';
      const paths = staleMap.paths.map(plain).join(', ');
      lines.push(`${whose} of ${plain(staleMap.repo)} is stale: ${paths}${more}`);
      read.add(repo.toLowerCase());
    }
    // A later run of the tests that passed, so found it fresh: a failing run judges no map.
    else if (
      ran.readings?.some(
        (reading) =>
          reading.check === 'test' && reading.result === 'exited' && reading.exitCode === 0,
      ) === true
    ) {
      read.add(repo.toLowerCase());
    }
  }
  return lines.reverse();
};

/** The modules the batch's test map adds with `coverage: none`, as one line, or none (ADR 0274). */
const unmeasuredLines = ({ unmeasured }: SensitiveFiles): string[] =>
  unmeasured === undefined
    ? []
    : [`Adds test map modules with coverage none: ${unmeasured.map(plain).join(', ')}`];

/** A pull request whose body the latest round left as it is (ADR 0227). */
export interface LeftBody {
  pullRequest: string;
  left: 'edited' | 'unmarked';
}

/**
 * One line per pull request of `urls`, in their order, with every one of `lines` that names it
 * joined onto it (ADR 0272); a line that names none of them stays a line of its own.
 */
const onePerPullRequest = (urls: readonly string[], lines: readonly string[]): string[] => {
  const said = new Map(urls.map((url) => [`- ${link(url)}`, [] as string[]]));
  const others: string[] = [];
  for (const line of lines) {
    const named = [...said.keys()].find((head) => line.startsWith(`${head} `));
    if (named === undefined) others.push(line);
    else said.get(named)?.push(line.slice(named.length + 1));
  }
  return [
    ...[...said].map(([head, clauses]) =>
      clauses.length === 0 ? head : `${head} ${clauses.join('; ')}`,
    ),
    ...others,
  ];
};

const leftBodyText: Record<LeftBody['left'], string> = {
  edited: 'its description was edited since Foedrum wrote it',
  unmarked: 'its description has no Foedrum marker',
};

/**
 * The status comment's text for `batch`, without its marker: its lane, its recipe's `steps` (the
 * steps the batch has when the recipe is unknown) with the current one marked, the `sensitive`
 * files its pushed change touches (ADR 0201), the assumptions of its out docs and, on tap, its pull
 * requests, with a link to the `brief` that says one is ready to merge (ADR 0225), or a line that
 * none is (ADR 0229), and the body the latest round `left` as it is (ADR 0227). Every text a brewer
 * or an issue wrote is one escaped line.
 */
export const renderStatus = (
  batch: Batch,
  steps?: readonly string[],
  isCommit: IsCommit = () => false,
  paused?: Pause,
  sensitive?: SensitiveFiles,
  usageWindows: UsageWindows = {},
  brief?: BriefLine,
  left?: LeftBody,
  /**
   * The pull request `openOf` reads, with the commit of its latest push, whose checks and base
   * checks the comment shows (ADR 0213, ADR 0226): no other is read any more.
   */
  open?: OpenPullRequest,
  /** The other open pull requests its open pull request conflicts with (ADR 0230). */
  pairs: readonly PairConflict[] = [],
  /** The state branch on the code host, whose out docs the steps and Assumptions link (ADR 0266). */
  stateBranchUrl?: string,
  /** The plan comment of the batch's order, which the lane and the Assumptions link (ADR 0275). */
  planComment?: string,
  /** The sub-issues its approved plan opened, once all are, which the On tap line names (ADR 0285). */
  subIssues?: readonly number[],
  /** Its order's sub-orders, in merge order, once it is split (ADR 0292, ADR 0293). */
  subOrderPulls: readonly SubOrderRow[] = [],
  /** The Brewery issue the comment is on, whose number its session line names (ADR 0329). */
  order: number = batch.issue,
  /** How its `Next:` and handover lines name its work, which a batch that is not the latest does by id (ADR 0334). */
  called: string = String(order),
  /** The Brewery issues its pre-existing findings opened once its pull requests merged (ADR 0356). */
  filed: readonly FiledIssue[] = [],
): string => {
  // Only what can be shown is read, on one line: an out doc of 1 MiB would cost a second a pass.
  const told: Told = (text, stepId, most = longest, cut = (kept) => kept) => {
    const shown = text.replace(/\s+/g, ' ').trim().slice(0, scanned);
    const kept = withoutSecrets(shown, stepId, isCommit);
    return plainWithin(kept === shown ? cut(kept) : kept, most);
  };
  // The recipe's steps, then any the batch has that the recipe no longer lists.
  const stepIds = [...new Set([...(steps ?? []), ...batch.steps.keys(), ...(batch.skipped ?? [])])];
  const sections = [
    [`### Foedrum · batch ${code(batch.id)}`],
    [
      ...laneText(batch, told, String(order), planComment, subIssues, subOrderPulls),
      ...failingLines(batch, told),
      ...orderEndLines(subOrderPulls),
      ...subOrderPulls.map(subOrderPullLine),
      ...(paused === undefined ? [] : [pauseText(paused)]),
      ...usageWindowLines(batch, usageWindows),
      ...nextLines(batch, subIssues, subOrderPulls, called, brief, open),
    ],
    [
      recipeText(batch.recipe),
      ...pathLines(batch, told),
      ...stepIds.flatMap((stepId) => [
        stepLine(batch, stepId, told, stateBranchUrl),
        ...coverageLines(batch, stepId, told),
      ]),
    ],
  ];
  // Before the sections that grow with the out docs, so a comment cut to length keeps it.
  if (sensitive !== undefined) {
    sections.push([sensitiveLine(sensitive), ...unmeasuredLines(sensitive)]);
  }
  // Before the sections that grow too, as a person accepted what these say (ADR 0345).
  const past = pastSkipLines(batch, told);
  if (past.length > 0) sections.push(['**Past a skip**', ...past]);
  const stale = staleMapLines(batch);
  if (stale.length > 0) sections.push(stale);
  const named = unreportedOf(batch);
  if (named !== undefined) {
    sections.push([unreportedLine(named.unreported, (name) => told(name, named.stepId))]);
  }
  const assumptions = assumptionLines(batch, stepIds, told, stateBranchUrl, planComment);
  if (assumptions.length > 0) sections.push(['**Assumptions**', ...assumptions]);
  const tests = testLines(batch, stepIds, told);
  if (tests.length > 0) sections.push(['**Tests**', ...tests]);
  const findings = [...findingLines(batch, stepIds, told), ...survivorLines(batch, stepIds, told)];
  if (findings.length > 0) sections.push(['**Findings**', ...findings]);
  if (filed.length > 0) {
    sections.push([
      '**Filed**',
      ...filed.map(
        ({ number, stepId, finding }) => `- #${number}: ${told(findingText(finding), stepId)}`,
      ),
    ]);
  }
  const risksLeft = riskLeftLines(batch, stepIds, told);
  if (risksLeft.length > 0) sections.push(['**Risk left**', ...risksLeft]);
  // How many, never what they say: ADR 0333 lets an earlier login's comment back into an order.
  const handed = handoversOf(batch).length;
  if (handed > 0) {
    sections.push([`${handoverLines(handed)}: ${code(`foedrum handover ${called}`)}`]);
  }
  const simplifications = simplificationLines(batch, stepIds, told);
  if (simplifications.length > 0) sections.push(['**Simplifications**', ...simplifications]);
  const receipts = receiptLines(batch, told);
  if (receipts.length > 0) sections.push(['**Receipts**', ...receipts]);
  if (batch.lane.kind === 'on_tap') {
    const { pullRequests } = batch.lane;
    sections.push(
      pullRequests.length === 0
        ? [
            // A split order's work is its sub-orders' pull requests, which the rows list (ADR 0293).
            subOrderPulls.length > 0 ? SPLIT : planned(batch) ? PLANNED : 'No pull request.',
          ]
        : [
            '**Pull requests**',
            ...onePerPullRequest(pullRequests, [
              ...pullRequests.flatMap((url) => baseCheckLine(batch, url, open) ?? []),
              ...pairs.map(pairLine),
              ...openCheckLines(batch, open),
              // The merge brief of the record that makes it ready now (ADR 0225).
              ...(brief === undefined || !('comment' in brief)
                ? []
                : [
                    `- ${link(brief.pullRequest)} is ready to merge on ${code(shortSha(brief.head))}: ${link(`${brief.pullRequest}#issuecomment-${brief.comment}`)}`,
                  ]),
              // An open pull request with no current brief (ADR 0229), or one that no longer holds.
              ...(brief === undefined || 'comment' in brief
                ? []
                : [
                    brief.held === undefined
                      ? `- ${link(brief.pullRequest)} is not ready to merge yet: no merge brief`
                      : `- ${link(brief.pullRequest)} is not ready to merge yet: its merge brief ${link(`${brief.pullRequest}#issuecomment-${brief.held.comment}`)} no longer holds on ${code(shortSha(brief.held.head))}`,
                  ]),
              // A body someone edited, or one with no marker, is not rendered again (ADR 0227).
              ...(left === undefined
                ? []
                : [`- ${link(left.pullRequest)} is left as it is: ${leftBodyText[left.left]}`]),
            ]),
          ],
    );
  }
  return cutForComment(sections.map((lines) => lines.join('\n')).join('\n\n'));
};

const revisions = commentRevisions('status', 'status comment');

/**
 * The id of the status comment of `batchId` the latest recorded revision made or edited, or
 * undefined before its first: a comment deleted by hand is made again with a new id.
 */
export const statusCommentOf = (state: State, batchId: string): number | undefined =>
  revisions.latest(state, batchId).latest?.comment;

/** The open pull request of `batch` whose body its latest round left as it is (ADR 0227). */
const leftBody = (state: State, batch: Batch): LeftBody | undefined => {
  const body = latestBody(state, batch.id);
  const url = openedPullRequest(state, batch.id);
  if (body === undefined || !('left' in body) || url === undefined) return undefined;
  if (batch.pullRequestEnds?.[url] !== undefined) return undefined;
  return { pullRequest: url, left: body.left };
};

/**
 * The revision of the status comment of `batchId` that the recorded events call for: the next one
 * when the batch's text is not the one the latest revision showed, else none. A claimed batch's is
 * on the Brewery issue that is its order, and none is due before that is recorded (ADR 0155).
 */
const statusDue = (
  state: State,
  batchId: string,
  steps?: readonly string[],
  stateBranchUrl?: string,
  planComment?: string,
): DueRevision | undefined => {
  const batch = state.batches.get(batchId);
  // A batch that ended is done: its comment showed that, and nothing reads a text it no longer has.
  if (batch === undefined || batch.endShown === true) return undefined;
  const issue = breweryIssueOf(state, batch);
  if (issue === undefined) return undefined;
  const { next: revision, latest: previous } = revisions.latest(state, batchId);
  // The latest push of the pull request recorded the sensitive files (ADR 0201, ADR 0219).
  const pushed = latestPush(state, batchId);
  const paused = pauseOf(state, batch);
  const text = renderStatus(
    batch,
    steps,
    knownCommits(state, batchId),
    paused,
    pushed?.sensitive,
    state.usageWindows,
    briefLine(state, batch),
    leftBody(state, batch),
    openOf(state, batch),
    pairsOf(state, batch).conflicts,
    stateBranchUrl,
    planComment,
    allSubIssues(state, batchId),
    batch.decomposed === true ? subOrderRows(state, batch.issue) : [],
    issue,
    calledAs(state, batch),
    filedIssues(state, batchId),
  );
  const digest = digestOf(text);
  if (previous?.digest === digest) return undefined;
  const open = !batchEnded(batch);
  const due = { key: revisions.keyOf(batchId, revision), issue, text, digest, open };
  return previous === undefined ? due : { ...due, previous };
};

export interface StatusEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  comments: StatusComments;
  recipes: Recipes;
  clock: () => Date;
  /** The state branch on the code host, `https://<host>/<brewery>/blob/foedrum/state` (ADR 0266). */
  stateBranchUrl?: string;
  /** The address of the plan comment of a batch's order, once it has one (ADR 0275). */
  planComment?: (state: State, batchId: string) => string | undefined;
}

const minuteMs = 60_000;

/**
 * The steps of `recipe` the status comment lists before the batch reaches them: all but a step
 * only a person's choice schedules, which it lists once it has an attempt (ADR 0286).
 */
const listedSteps = (recipe: Recipe | undefined): readonly string[] | undefined => {
  if (recipe === undefined) return undefined;
  const chosen = new Set(ChosenBy.options.map((option) => recipe.chosen(option)));
  return recipe.steps.filter((stepId) => !chosen.has(stepId));
};

/**
 * The status comment of every batch of a Brewery issue, a claimed batch's order included, for the
 * driver: a revision whenever its text changed, at most one a minute per batch, except its first
 * and one that shows it ended or Stuck, which are due at once (ADR 0072, ADR 0155, ADR 0330).
 */
export const statusEffects = (options: StatusEffectsOptions): DriverEffects => {
  const { brewery, comments, recipes, clock, stateBranchUrl, planComment } = options;
  // When this driver last applied or found a revision of each batch.
  const lastAt = new Map<string, number>();
  const status = revisions.effects(brewery, comments, (due) =>
    lastAt.set(due.key.batchId, clock().getTime()),
  );
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      const name = batch?.recipe?.name;
      const due = statusDue(
        state,
        batchId,
        name === undefined ? undefined : listedSteps(recipes.find(name)),
        stateBranchUrl,
        planComment?.(state, batchId),
      );
      if (batch === undefined || due === undefined) return [];
      // The lanes where a run may end, so no later pass shows them: `foedrum brew` exits at Stuck
      // too, and only a person's command takes a batch out of Stuck (ADR 0072, ADR 0330).
      const { kind } = batch.lane;
      const atOnce = kind === 'on_tap' || kind === 'cancelled' || kind === 'stuck';
      const last = lastAt.get(batchId);
      if (due.previous !== undefined && !atOnce && last !== undefined) {
        if (clock().getTime() - last < minuteMs) return [];
      }
      return [status.due(due)];
    },
    target: status.target,
  };
};
