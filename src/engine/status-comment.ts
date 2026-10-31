// The status comment of a batch of a Brewery issue (architecture §8, ADR 0072): its text rendered
// from the folded state alone, and its edits as revisions in the ledger, `[batchId, "status.<n>"]`,
// each found by its marker on the Brewery's own comment before it is applied (ADR 0033).

import type { IsCommit } from '../formats/secrets.ts';
import type { GravityReading, RoundsOut, StuckReason, WaitCondition } from '../schemas/events.ts';
import { finingOf, gaugeOf, OutDocAssumptions, tastingOf } from '../schemas/out-doc.ts';
import { planOf } from '../schemas/plan.ts';
import type { MergeBrief } from '../schemas/status-comment.ts';
import type { SensitiveFiles } from '../schemas/store.ts';
import { breweryIssueOf } from './claim-orders.ts';
import { commentRevisions, cutForComment, type DueRevision } from './comment-revisions.ts';
import type { DriverEffects } from './driver.ts';
import {
  type Attempt,
  type Batch,
  baseChecksOn,
  type Input,
  type Pause,
  type State,
  type UsageWindows,
} from './fold.ts';
import { briefLine } from './merge-brief.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { pauseOf, stopAtText } from './pauses.ts';
import { checkPassed } from './pr-checks.ts';
import {
  changeText,
  digestOf,
  findingText,
  knownCommits,
  latestBody,
  latestPush,
  openedPullRequest,
  openOf,
} from './pull-request.ts';
import { type PairConflict, pairsOf } from './pull-request-pairs.ts';
import { receiptParts, receiptsOf } from './receipt.ts';
import type { Recipes } from './recipes.ts';
import { resumedAfterOverrun } from './session-resume.ts';
import { outDocLink } from './state-branch.ts';
import { usageWindowsText } from './usage-window.ts';

/**
 * What the status comment says of a pull request's merge brief: the current one, or the open pull
 * request that has none (ADR 0229).
 */
export type BriefLine = MergeBrief | { pullRequest: string };

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
  create(repo: string, issue: number, body: string, signal?: AbortSignal): Promise<number>;
  /** Replaces the body of `comment`; `gone` when it was deleted. */
  edit(
    repo: string,
    comment: number,
    body: string,
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
const plainWithin = (text: string, most: number): string => {
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
 * What a person does with a plan that waits for its review (ADR 0281), until its sub-orders become
 * sub-issues (#590): `command` writes a command as the reader shows it.
 */
export const planNextStep = (batchId: string, command: (text: string) => string): string =>
  `read the plan and its assumptions; sign it off with ${command(`foedrum approve ${batchId}`)}, plan it again with ${command(`foedrum retry ${batchId}`)}, or end it with ${command(`foedrum cancel ${batchId}`)}. Its sub-orders become issues once #590 is built.`;

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
 * The command that opens the session a batch waits for (ADR 0222): `foedrum brew` of its issue in
 * a terminal, taking the batch from the driver that parked it. A target issue's order is named by
 * its repository's alias, which only foedrum.jsonc knows.
 */
export const sessionCommand = ({ issue, repo }: Pick<Batch, 'issue' | 'repo'>): string =>
  `foedrum brew ${repo === undefined ? issue : `<alias of ${repo}>#${issue}`} --take`;

const stuckText = (reason: StuckReason, told: Told, batch: Batch, planComment?: string): string => {
  switch (reason.kind) {
    case 'needs_input':
      return `${code(reason.stepId)} needs input`;
    case 'blocked':
      return `${code(reason.stepId)} is blocked (${reason.blockerKind}): ${told(reason.summary, reason.stepId)}`;
    case 'attempts_exhausted':
      return `${code(reason.stepId)} used its ${reason.attempts} attempts; the last: ${told(reason.lastReason, reason.stepId)}`;
    case 'deadline_passed':
      return `${code(reason.stepId)} passed its deadline of ${reason.deadlineAt}`;
    case 'waiting_for_session':
      return `${code(reason.stepId)} waits for its session: run ${code(sessionCommand(batch))} in a terminal (ADR 0222)`;
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
      const at = planComment === undefined ? '' : `: ${link(planComment)}`;
      return `the plan of ${code(reason.stepId)} #${reason.attempt} is ready for your review${at}`;
    }
    // Who stopped it and why are a person's words, shown as plain text (ADR 0205).
    case 'stopped': {
      const why = reason.why === undefined ? '' : `: ${plain(reason.why)}`;
      return `${code(reason.stepId)} was stopped by ${plain(reason.by)} (${reason.via})${why}`;
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

/** A reading that did not pass, as a check step's reason says it (ADR 0069, ADR 0140). */
export const readingText = (reading: GravityReading): string => {
  const what = checkOf(reading);
  switch (reading.result) {
    case 'skipped':
      return `${what} was skipped`;
    case 'exited':
      return `${what} failed with exit code ${reading.exitCode}`;
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

/** The lane, and for Stuck what gets it moving; never a reminder's time, which changes alone. */
const laneText = (batch: Batch, told: Told, planComment?: string): string[] => {
  const { lane } = batch;
  switch (lane.kind) {
    case 'ordered':
      return ['📥 **Ordered**: waiting for a recipe'];
    case 'brewing':
      return ['🍺 **Brewing**'];
    case 'conditioning':
      return [`⏳ **Conditioning**: waiting for ${waitText(lane.on)}`];
    case 'stuck': {
      const { reason, options } = lane;
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
      return [
        `🔔 **Stuck**: ${stuckText(reason, told, batch, planComment)}`,
        ...questions,
        // What to do with a plan that waits for its review (ADR 0275, ADR 0281).
        ...(reason.kind === 'plan_review' ? [`Next: ${planNextStep(batch.id, code)}`] : []),
        ...(reason.kind === 'blocked' && reason.roundsOut !== undefined
          ? openLines(reason.stepId, reason.roundsOut, told)
          : []),
        `Get it moving with ${options.map(code).join(', ')}.`,
      ];
    }
    case 'on_tap': {
      // A plan a person signed off is on tap with no pull request (ADR 0281).
      const { approval } = batch;
      if (approval === undefined) return ['🍻 **On tap**'];
      return [`🍻 **On tap**: plan approved by ${plain(approval.by)} (${approval.via})`];
    }
    case 'cancelled':
      return [`🚫 **Cancelled** by ${plain(lane.by)} (${lane.via})`];
    default:
      return lane satisfies never;
  }
};

/**
 * What a batch on tap with a plan and no pull request says: the plan comment shows it (ADR 0234).
 * A batch is on tap with one when a person approved it (ADR 0281), or when it was recorded before
 * a plan waited Stuck for its review (ADR 0275).
 */
const PLANNED =
  'No pull request: the plan is in its own comment on this issue, and nothing is built from it yet.';

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
      return `${name}, chosen by its label`;
    case 'router':
      return `${name}, chosen by the router: ${plain(recipe.reason)}`;
    case 'human':
      return `${name}, chosen by ${plain(recipe.by)} (${recipe.via})`;
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
 * it, since its body reads (ADR 0275), any other's as written.
 */
const outDocUrl = (
  batch: Batch,
  stepId: string,
  done: { attempt: number; output: unknown },
  stateBranchUrl: string,
): string =>
  outDocLink(
    stateBranchUrl,
    { batchId: batch.id, stepId, attempt: done.attempt },
    planOf(done.output) !== undefined,
  );

const stepLine = (batch: Batch, stepId: string, told: Told, stateBranchUrl?: string): string => {
  const id = code(stepId);
  if (batch.skipped?.has(stepId) === true) return `- ⏭️ ${id}: skipped`;
  const [latest] = latestFirst(batch, stepId);
  if (latest === undefined) return `- ⬜ ${id}`;
  const n = latest.attempt;
  if (stuckStep(batch) === stepId) return `- 🔔 ${id}: stuck at attempt ${n}`;
  if (latest.phase !== 'finished') {
    if (latest.abandoned === true) return `- ⏹️ ${id}: attempt ${n} stopped`;
    // A person's open session has no deadline: the comment says since when it waits (ADR 0222).
    if (latest.phase === 'started' && latest.interactiveSince !== undefined) {
      return `- ▶️ ${id}: session open since ${latest.interactiveSince}, attempt ${n}`;
    }
    const resumed = resumedAfterOverrun(batch, { batchId: batch.id, stepId, attempt: n });
    return `- ▶️ ${id}: brewing, attempt ${n}${resumed ? `, ${afterTheBudget}` : ''}`;
  }
  const { outcome } = latest;
  switch (outcome.kind) {
    // The out doc the step's line sums up, linked (ADR 0275): a check step and an action, as
    // openPullRequest, write none, and every out doc has its assumptions.
    case 'succeeded':
      return stateBranchUrl === undefined || !OutDocAssumptions.safeParse(outcome.output).success
        ? `- ✅ ${id}`
        : `- ✅ ${id}: out doc: ${link(outDocUrl(batch, stepId, { attempt: n, output: outcome.output }, stateBranchUrl))}`;
    case 'failed':
      return `- ❌ ${id}: attempt ${n} failed: ${told(outcome.reason, stepId)}`;
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
      return `${mark} ${told(outcome.reason, stepId, longest, reasonClause)}`;
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
  return rounds.map((round, n) => `${n === 0 ? 'Path: ' : '→ '}${round.join(' → ')}`);
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
  const shown = planComment === undefined ? '' : `; plan comment: ${link(planComment)}`;
  return [
    `- ${code(stepId)}: full plan: ${link(outDocUrl(batch, stepId, done, stateBranchUrl))}${shown}`,
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

/** The output of `stepId`'s latest finished attempt when it succeeded; else undefined. */
const latestOutput = (batch: Batch, stepId: string): unknown => {
  const finished = latestFirst(batch, stepId).find((attempt) => attempt.phase === 'finished');
  return finished?.phase === 'finished' && finished.outcome.kind === 'succeeded'
    ? finished.outcome.output
    : undefined;
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
      ...laneText(batch, told, planComment),
      ...(paused === undefined ? [] : [pauseText(paused)]),
      ...usageWindowLines(batch, usageWindows),
    ],
    [
      recipeText(batch.recipe),
      ...pathLines(batch, told),
      ...stepIds.map((stepId) => stepLine(batch, stepId, told, stateBranchUrl)),
    ],
  ];
  // Before the sections that grow with the out docs, so a comment cut to length keeps it.
  if (sensitive !== undefined) sections.push([sensitiveLine(sensitive)]);
  const assumptions = assumptionLines(batch, stepIds, told, stateBranchUrl, planComment);
  if (assumptions.length > 0) sections.push(['**Assumptions**', ...assumptions]);
  const tests = testLines(batch, stepIds, told);
  if (tests.length > 0) sections.push(['**Tests**', ...tests]);
  const findings = findingLines(batch, stepIds, told);
  if (findings.length > 0) sections.push(['**Findings**', ...findings]);
  const risksLeft = riskLeftLines(batch, stepIds, told);
  if (risksLeft.length > 0) sections.push(['**Risk left**', ...risksLeft]);
  const simplifications = simplificationLines(batch, stepIds, told);
  if (simplifications.length > 0) sections.push(['**Simplifications**', ...simplifications]);
  const receipts = receiptLines(batch, told);
  if (receipts.length > 0) sections.push(['**Receipts**', ...receipts]);
  if (batch.lane.kind === 'on_tap') {
    const { pullRequests } = batch.lane;
    sections.push(
      pullRequests.length === 0
        ? [planned(batch) ? PLANNED : 'No pull request.']
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
              // An open pull request with no current brief (ADR 0229).
              ...(brief === undefined || 'comment' in brief
                ? []
                : [`- ${link(brief.pullRequest)} is not ready to merge yet: no merge brief`]),
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
  if (batch === undefined) return undefined;
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
  );
  const digest = digestOf(text);
  if (previous?.digest === digest) return undefined;
  const due = { key: revisions.keyOf(batchId, revision), issue, text, digest };
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
 * The status comment of every batch of a Brewery issue, a claimed batch's order included, for the
 * driver: a revision whenever its text changed, at most one a minute per batch, except its first
 * and the one that shows it ended, which are due at once (ADR 0072, ADR 0155).
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
        name === undefined ? undefined : recipes.find(name)?.steps,
        stateBranchUrl,
        planComment?.(state, batchId),
      );
      if (batch === undefined || due === undefined) return [];
      // A plan to review is where the recipe ended, so its revision is due at once (ADR 0275).
      const review = batch.lane.kind === 'stuck' && batch.lane.reason.kind === 'plan_review';
      const ended = batch.lane.kind === 'on_tap' || batch.lane.kind === 'cancelled' || review;
      const last = lastAt.get(batchId);
      if (due.previous !== undefined && !ended && last !== undefined) {
        if (clock().getTime() - last < minuteMs) return [];
      }
      return [status.due(due)];
    },
    target: status.target,
  };
};
