// The status comment of a batch of a Brewery issue (architecture §8, ADR 0072): its text rendered
// from the folded state alone, and its edits as revisions in the ledger, `[batchId, "status.<n>"]`,
// each found by its marker on the Brewery's own comment before it is applied (ADR 0033).

import { createHash } from 'node:crypto';
import type { IsCommit } from '../formats/secrets.ts';
import type { GravityReading, RoundsOut, StuckReason, WaitCondition } from '../schemas/events.ts';
import { finingOf, gaugeOf, OutDocAssumptions, tastingOf } from '../schemas/out-doc.ts';
import { StatusRevision } from '../schemas/status-comment.ts';
import { type BatchEffectKey, PushResult, type SensitiveFiles } from '../schemas/store.ts';
import { effectMarker } from './claim-effects.ts';
import { breweryIssueOf } from './claim-orders.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { Attempt, Batch, Lane, Pause, State, UsageWindow } from './fold.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { pauseOf, stopAtText } from './pauses.ts';
import { changeText, findingText, knownCommits, pushKey } from './pull-request.ts';
import { receiptParts, receiptsOf } from './receipt.ts';
import type { Recipes } from './recipes.ts';
import { resumedAfterOverrun } from './session-resume.ts';
import { usageWindowText } from './usage-window.ts';

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
/**
 * How long the text may be: below GitHub's 65,536 characters for a comment, with room for the
 * marker. Escaping can make each text a brewer wrote five times as long, so the caps alone do not
 * keep it there.
 */
const longestText = 60_000;

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
 * `text`, which a brewer or an issue wrote, as one line of at most `longest` characters that
 * GitHub renders as it is: no Markdown, no HTML (so no marker), and no mention. It is cut after
 * escaping, between characters, so no escape is cut in half and the line never grows past
 * `longest`.
 */
export const plain = (text: string): string => {
  const shown = [...text.replace(/\s+/g, ' ').trim()].map(shownAsItself);
  const whole = shown.join('');
  if (whole.length <= longest) return whole;
  let line = '';
  for (const each of shown) {
    if (line.length + each.length > longest - 1) break;
    line += each;
  }
  return `${line}…`;
};

const code = (id: string): string => `\`${id}\``;

/**
 * What the status comment and `foedrum stuck` recommend when a findings route ran out of rounds,
 * until the analyse recipe can plan the order again itself (ADR 0192, #388).
 */
export const STEP_BACK = 'Another round is unlikely to help: plan the order again, or split it.';

/** `rounds` rounds of a findings route, in words. */
export const roundsText = (rounds: number): string =>
  `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`;

/** A text a brewer wrote at `stepId` as one plain line, or a fixed line when it looks like a secret. */
type Told = (text: string, stepId: string) => string;

/**
 * A URL as an autolink of its normalized form: the schema keeps the text it was given, and `new URL`
 * encodes the spaces and angle brackets that would let the rest of it render as Markdown.
 */
const link = (url: string): string => `<${new URL(url).href}>`;

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

const stuckText = (reason: StuckReason, told: Told): string => {
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
      return `${code(reason.stepId)} waits for its session`;
    case 'stalled':
      return `${code(reason.stepId)} stalled: no file written and no commit made since ${reason.lastProgressAt}, for ${reason.turnsWithoutProgress} turns`;
    case 'routing':
      return `no recipe was chosen by its routing deadline, ${reason.deadlineAt}`;
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
const shortSha = (sha: string): string => sha.slice(0, 8);

/**
 * How the pull request `url` of `batch` merges with its base, by its latest check (ADR 0198): the
 * tip and the files of a conflict, or that it merges cleanly again after an earlier conflict; on
 * the merged tree (ADR 0203), the check that failed and how, why the checks did not run, or that
 * they pass again after either; `undefined` when every check was clean or none ran.
 */
const baseCheckLine = (batch: Batch, url: string): string | undefined => {
  const checks = (batch.baseChecks ?? []).filter((check) => check.pullRequest === url);
  const latest = checks.at(-1);
  // An ended pull request is checked no more: its last check says nothing now.
  if (latest === undefined || batch.pullRequestEnds?.[url] !== undefined) return undefined;
  // The branch comes from the Brewery's config; a file's name from whoever committed it.
  const branch = code(latest.branch);
  if (latest.branchMoved !== undefined) {
    return `- ${link(url)} is not checked against ${branch} since someone else pushed to its branch`;
  }
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

/** The lines of the pull requests of a batch on tap that its base checks have something to say of. */
export const baseCheckLines = (batch: Batch): string[] =>
  batch.lane.kind === 'on_tap'
    ? batch.lane.pullRequests.flatMap((url) => baseCheckLine(batch, url) ?? [])
    : [];

/** The lane, and for Stuck what gets it moving; never a reminder's time, which changes alone. */
const laneText = (lane: Lane, told: Told): string[] => {
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
        `🔔 **Stuck**: ${stuckText(reason, told)}`,
        ...questions,
        ...(reason.kind === 'blocked' && reason.roundsOut !== undefined
          ? openLines(reason.stepId, reason.roundsOut, told)
          : []),
        `Get it moving with ${options.map(code).join(', ')}.`,
      ];
    }
    case 'on_tap':
      return ['🍻 **On tap**'];
    case 'cancelled':
      return [`🚫 **Cancelled** by ${plain(lane.by)} (${lane.via})`];
    default:
      return lane satisfies never;
  }
};

/** Who paused the batch, from where and why, and when what still runs is stopped (ADR 0202). */
const pauseText = ({ by, via, why, stopAt }: Pause): string => {
  const reason = why === undefined ? '' : `: ${plain(why)}`;
  const stopped =
    stopAt === undefined ? '' : `, and what still runs at ${plain(stopAtText(stopAt))} is stopped`;
  return `⏸️ **Paused** by ${plain(by)} (${via})${reason}. Nothing new starts; what runs ends at its next convenient point${stopped}.`;
};

/** What a brewing batch shows while the usage window is closed (ADR 0206). */
const usageWindowLines = (batch: Batch, window: UsageWindow | undefined): string[] =>
  window === undefined || batch.lane.kind !== 'brewing'
    ? []
    : [`⏳ ${plain(usageWindowText(window))}.`];

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

const stepLine = (batch: Batch, stepId: string, told: Told): string => {
  const id = code(stepId);
  if (batch.skipped?.has(stepId) === true) return `- ⏭️ ${id}: skipped`;
  const [latest] = latestFirst(batch, stepId);
  if (latest === undefined) return `- ⬜ ${id}`;
  const { lane } = batch;
  const n = latest.attempt;
  if (lane.kind === 'stuck' && 'stepId' in lane.reason && lane.reason.stepId === stepId) {
    return `- 🔔 ${id}: stuck at attempt ${n}`;
  }
  if (latest.phase !== 'finished') {
    if (latest.abandoned === true) return `- ⏹️ ${id}: attempt ${n} stopped`;
    const resumed = resumedAfterOverrun(batch, { batchId: batch.id, stepId, attempt: n });
    return `- ▶️ ${id}: brewing, attempt ${n}${resumed ? `, ${afterTheBudget}` : ''}`;
  }
  const { outcome } = latest;
  switch (outcome.kind) {
    case 'succeeded':
      return `- ✅ ${id}`;
    case 'failed':
      return `- ❌ ${id}: attempt ${n} failed: ${told(outcome.reason, stepId)}`;
    case 'needs_input':
      return `- ❓ ${id}: attempt ${n} asked for input`;
    case 'cancelled':
      return `- ⏹️ ${id}: attempt ${n} stopped`;
    default:
      return outcome satisfies never;
  }
};

/** How attempt `n` of `stepId` stands, as the step list marks it. */
const markOf = (batch: Batch, stepId: string, n: number): string => {
  const attempt = batch.steps.get(stepId)?.attempts.get(n);
  const { lane } = batch;
  const latest = latestFirst(batch, stepId)[0]?.attempt;
  if (lane.kind === 'stuck' && 'stepId' in lane.reason && lane.reason.stepId === stepId) {
    if (latest === n) return '🔔';
  }
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
 * The batch's attempts in the order they ran, each marked, on one line; none before its first.
 * Each is a code span: GitHub would link a bare `#1` to issue 1.
 */
const pathLine = (batch: Batch): string[] => {
  const { path = [], lane } = batch;
  // Stuck at an attempt that never started: the path ends there all the same.
  const stuckAt = lane.kind === 'stuck' && 'stepId' in lane.reason ? lane.reason.stepId : undefined;
  const latest = stuckAt === undefined ? undefined : latestFirst(batch, stuckAt)[0]?.attempt;
  const onPath = path.some((each) => each.stepId === stuckAt && each.attempt === latest);
  const all =
    stuckAt === undefined || latest === undefined || onPath
      ? path
      : [...path, { stepId: stuckAt, attempt: latest }];
  if (all.length === 0) return [];
  const shown = all.map(
    ({ stepId, attempt }) => `${code(`${stepId} #${attempt}`)} ${markOf(batch, stepId, attempt)}`,
  );
  return [`Path: ${shown.join(' → ')}`];
};

/** The assumptions of the latest out doc of `stepId` that succeeded. */
const assumptionsOf = (batch: Batch, stepId: string, told: Told): string[] => {
  for (const attempt of latestFirst(batch, stepId)) {
    if (attempt.phase !== 'finished' || attempt.outcome.kind !== 'succeeded') continue;
    const parsed = OutDocAssumptions.safeParse(attempt.outcome.output);
    if (!parsed.success) return [];
    return parsed.data.assumptions.map((text) => told(text, stepId)).filter((text) => text !== '');
  }
  return [];
};

/** The first `most` of `all` as lines of `stepId`, and a line that counts the rest, as `rest`. */
const capped = <T>(
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

const assumptionLines = (batch: Batch, stepIds: readonly string[], told: Told): string[] =>
  stepIds.flatMap((stepId) =>
    capped(stepId, assumptionsOf(batch, stepId, told), mostAssumptions, (text) => text),
  );

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
    const done = latestFirst(batch, stepId).find(
      (attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
    );
    const named =
      done?.phase === 'finished' && done.outcome.kind === 'succeeded'
        ? gaugeOf(done.outcome.output)
        : undefined;
    if (named === undefined) return [];
    const kind = (names: readonly string[], what: string): string[] =>
      capped(stepId, names, mostTests, (name) => `${what}: ${told(name, stepId)}`, ` ${what}s`);
    return [...kind(named.tests, 'new test'), ...kind(named.regressionTests, 'regression test')];
  });

/** How many findings of one Taster's step the comment shows. */
const mostFindings = 10;

/**
 * The findings of each Taster's step whose latest finished attempt succeeded (ADR 0161): a blocking
 * verdict ends its attempt blocked, and an earlier round's findings are no longer current.
 */
const findingLines = (batch: Batch, stepIds: readonly string[], told: Told): string[] =>
  stepIds.flatMap((stepId) =>
    capped(
      stepId,
      tastingOf(latestOutput(batch, stepId))?.findings ?? [],
      mostFindings,
      (finding) => `${told(findingText(finding), stepId)}: ${told(finding.why, stepId)}`,
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
const sensitiveLine = (sensitive: SensitiveFiles): string => {
  const named = sensitive.files.slice(0, mostSensitive).map(plain);
  const more = sensitive.count - named.length;
  return `Touches sensitive paths: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

/**
 * The status comment's text for `batch`, without its marker: its lane, its recipe's `steps` (the
 * steps the batch has when the recipe is unknown) with the current one marked, the `sensitive`
 * files its pushed change touches (ADR 0201), the assumptions of its out docs and, on tap, its pull
 * requests. Every text a brewer or an issue wrote is one escaped line.
 */
export const renderStatus = (
  batch: Batch,
  steps?: readonly string[],
  isCommit: IsCommit = () => false,
  paused?: Pause,
  sensitive?: SensitiveFiles,
  usageWindow?: UsageWindow,
): string => {
  // Only what can be shown is read, on one line: an out doc of 1 MiB would cost a second a pass.
  const told: Told = (text, stepId) => {
    const shown = text.replace(/\s+/g, ' ').trim().slice(0, scanned);
    return plain(withoutSecrets(shown, stepId, isCommit));
  };
  // The recipe's steps, then any the batch has that the recipe no longer lists.
  const stepIds = [...new Set([...(steps ?? []), ...batch.steps.keys(), ...(batch.skipped ?? [])])];
  const sections = [
    [`### Foedrum · batch ${code(batch.id)}`],
    [
      ...laneText(batch.lane, told),
      ...(paused === undefined ? [] : [pauseText(paused)]),
      ...usageWindowLines(batch, usageWindow),
    ],
    [
      recipeText(batch.recipe),
      ...pathLine(batch),
      ...stepIds.map((stepId) => stepLine(batch, stepId, told)),
    ],
  ];
  // Before the sections that grow with the out docs, so a comment cut to length keeps it.
  if (sensitive !== undefined) sections.push([sensitiveLine(sensitive)]);
  const assumptions = assumptionLines(batch, stepIds, told);
  if (assumptions.length > 0) sections.push(['**Assumptions**', ...assumptions]);
  const tests = testLines(batch, stepIds, told);
  if (tests.length > 0) sections.push(['**Tests**', ...tests]);
  const findings = findingLines(batch, stepIds, told);
  if (findings.length > 0) sections.push(['**Findings**', ...findings]);
  const simplifications = simplificationLines(batch, stepIds, told);
  if (simplifications.length > 0) sections.push(['**Simplifications**', ...simplifications]);
  const receipts = receiptLines(batch, told);
  if (receipts.length > 0) sections.push(['**Receipts**', ...receipts]);
  if (batch.lane.kind === 'on_tap') {
    const { pullRequests } = batch.lane;
    sections.push(
      pullRequests.length === 0
        ? ['No pull request.']
        : [
            '**Pull requests**',
            ...pullRequests.map((url) => baseCheckLine(batch, url) ?? `- ${link(url)}`),
          ],
    );
  }
  const text = sections.map((lines) => lines.join('\n')).join('\n\n');
  if (text.length <= longestText) return text;
  // Whole lines only, so no escape or entity is cut in half.
  const cutNote = '\n\n… the rest is cut: GitHub keeps comments shorter.';
  const kept = text.slice(0, longestText - cutNote.length);
  return `${kept.slice(0, kept.lastIndexOf('\n'))}${cutNote}`;
};

/** The first 16 hex digits of the SHA-256 of `text`: what a revision records of it. */
const digestOf = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

const revisionKey = (batchId: string, revision: number): BatchEffectKey => ({
  batchId,
  effect: `status.${revision}`,
});

/** What revision `revision` of `batchId` recorded, or undefined when it is not in the ledger. */
const recorded = (state: State, batchId: string, revision: number): StatusRevision | undefined => {
  const key = effectKey.encode(revisionKey(batchId, revision));
  if (!state.effects.has(key)) return undefined;
  const parsed = StatusRevision.safeParse(state.effects.get(key));
  if (!parsed.success) throw new Error(`The ledger's ${key} is not a status comment's revision`);
  return parsed.data;
};

/**
 * The id of the status comment of `batchId` the latest recorded revision made or edited, or
 * undefined before its first: a comment deleted by hand is made again with a new id.
 */
export const statusCommentOf = (state: State, batchId: string): number | undefined =>
  latestRevision(state, batchId).latest?.comment;

/** The latest revision of `batchId` recorded, if any, and the number of the next. */
const latestRevision = (
  state: State,
  batchId: string,
): { next: number; latest: StatusRevision | undefined } => {
  let next = 1;
  let latest: StatusRevision | undefined;
  for (let found = recorded(state, batchId, next); found !== undefined; ) {
    latest = found;
    next += 1;
    found = recorded(state, batchId, next);
  }
  return { next, latest };
};

/** A revision of a status comment that is due. */
interface DueRevision {
  key: BatchEffectKey;
  issue: number;
  text: string;
  digest: string;
  /** The latest revision recorded; absent for the first. */
  previous?: StatusRevision;
}

/**
 * The revision of the status comment of `batchId` that the recorded events call for: the next one
 * when the batch's text is not the one the latest revision showed, else none. A claimed batch's is
 * on the Brewery issue that is its order, and none is due before that is recorded (ADR 0155).
 */
const statusDue = (
  state: State,
  batchId: string,
  steps?: readonly string[],
): DueRevision | undefined => {
  const batch = state.batches.get(batchId);
  if (batch === undefined) return undefined;
  const issue = breweryIssueOf(state, batch);
  if (issue === undefined) return undefined;
  const { next: revision, latest: previous } = latestRevision(state, batchId);
  // The push of the pull request recorded the sensitive files once (ADR 0201).
  const pushed = PushResult.safeParse(state.effects.get(effectKey.encode(pushKey(batchId))));
  const sensitive = pushed.success ? pushed.data.sensitive : undefined;
  const paused = pauseOf(state, batch);
  const text = renderStatus(
    batch,
    steps,
    knownCommits(state, batchId),
    paused,
    sensitive,
    state.usageWindow,
  );
  const digest = digestOf(text);
  if (previous?.digest === digest) return undefined;
  const due = { key: revisionKey(batchId, revision), issue, text, digest };
  return previous === undefined ? due : { ...due, previous };
};

export interface StatusEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  comments: StatusComments;
  recipes: Recipes;
  clock: () => Date;
}

const minuteMs = 60_000;

/** A revision's result, checked: the id comes from the code host, and the ledger keeps it. */
const revisionOf = (comment: number, digest: string): StatusRevision => {
  const parsed = StatusRevision.safeParse({ comment, digest });
  if (!parsed.success) {
    throw new Error(`The code host answered a comment id that is no positive integer: ${comment}`);
  }
  return parsed.data;
};

/**
 * The status comment of every batch of a Brewery issue, a claimed batch's order included, for the
 * driver: a revision whenever its text changed, at most one a minute per batch, except its first
 * and the one that shows it ended, which are due at once (ADR 0072, ADR 0155).
 */
export const statusEffects = (options: StatusEffectsOptions): DriverEffects => {
  const { brewery, comments, recipes, clock } = options;
  // The revision behind each key `due` gave; the driver asks `due` before it applies a key.
  const revisions = new Map<string, DueRevision>();
  // When this driver last applied or found a revision of each batch.
  const lastAt = new Map<string, number>();
  const revisionFor = (key: string): DueRevision => {
    const due = revisions.get(key);
    if (due === undefined) throw new Error(`No status comment revision ${key} is due`);
    return due;
  };
  const done = (due: DueRevision, result: StatusRevision): StatusRevision => {
    lastAt.set(due.key.batchId, clock().getTime());
    return result;
  };
  // The comment that already shows the revision of `key`, by the text before its marker.
  const shown = (due: DueRevision, comment: number, body: string, marker: string) => ({
    result: done(due, revisionOf(comment, digestOf(body.slice(0, -marker.length).trimEnd()))),
  });
  const target: EffectTarget = {
    find: async (key, signal) => {
      const due = revisionFor(key);
      const marker = effectMarker(key);
      if (due.previous !== undefined) {
        const body = await comments.read(brewery, due.previous.comment, signal);
        // Still there: a run before would have edited it, not made another.
        if (body !== undefined) {
          return body.endsWith(marker) ? shown(due, due.previous.comment, body, marker) : undefined;
        }
      }
      const found = await comments.find(brewery, due.issue, marker, signal);
      return found === undefined ? undefined : shown(due, found.id, found.body, marker);
    },
    apply: async (key, signal) => {
      const due = revisionFor(key);
      const body = `${due.text}\n\n${effectMarker(key)}`;
      if (due.previous !== undefined) {
        const edited = await comments.edit(brewery, due.previous.comment, body, signal);
        if (edited === 'edited') return done(due, revisionOf(due.previous.comment, due.digest));
      }
      // The first revision, or the comment was deleted by hand: it is made again.
      const id = await comments.create(brewery, due.issue, body, signal);
      return done(due, revisionOf(id, due.digest));
    },
  };
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      const name = batch?.recipe?.name;
      const due = statusDue(
        state,
        batchId,
        name === undefined ? undefined : recipes.find(name)?.steps,
      );
      if (batch === undefined || due === undefined) return [];
      const ended = batch.lane.kind === 'on_tap' || batch.lane.kind === 'cancelled';
      const last = lastAt.get(batchId);
      if (due.previous !== undefined && !ended && last !== undefined) {
        if (clock().getTime() - last < minuteMs) return [];
      }
      revisions.set(effectKey.encode(due.key), due);
      return [due.key];
    },
    target,
  };
};
