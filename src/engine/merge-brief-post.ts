// The merge brief on a ready pull request (ADR 0225): one comment through the ledger per ready
// record, `[batch, "brief.<n>"]`, titled `Merge? <title> @ <short sha>`, with the verdict, what
// changed since it opened, the evidence on its head and the last Taster's risk left, every fact
// from the ledger and every model text filtered under its own heading.

import type { IsCommit } from '../formats/secrets.ts';
import type { GravityReading } from '../schemas/events.ts';
import { lensFirst, placeOf, type TastingFinding, tastingOf } from '../schemas/out-doc.ts';
import { MergeBrief } from '../schemas/status-comment.ts';
import { PushResult } from '../schemas/store.ts';
import { pullRequestOf } from './base-check.ts';
import { effectMarker } from './claim-effects.ts';
import { onFindings } from './decide.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { Attempt, Batch, State } from './fold.ts';
import { type LensRound, lensRounds } from './lens-rounds.ts';
import { briefKey, briefOf, latestBrief, type ReadyRecord, readyOf } from './merge-brief.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { findingText, knownCommits, latestPush, recordedPushes, unlinked } from './pull-request.ts';
import type { Recipe, Recipes } from './recipes.ts';
import {
  capped,
  checkOf,
  code,
  link,
  plain,
  readingText,
  sensitiveLine,
  shortSha,
} from './status-comment.ts';

/** The pull request's comments and title on the code host, as the Brewery's own identity has them. */
export interface MergeBriefHost {
  /** The Brewery's own comment on the pull request whose body ends with `end`: its id and body. */
  find(
    repo: string,
    number: number,
    end: string,
    signal?: AbortSignal,
  ): Promise<{ id: number; body: string } | undefined>;
  /** Comments on the pull request; the new comment's id. */
  create(repo: string, number: number, body: string, signal?: AbortSignal): Promise<number>;
  /** The pull request's title. */
  title(repo: string, number: number, signal?: AbortSignal): Promise<string>;
}

export interface MergeBriefEffectsOptions {
  host: MergeBriefHost;
  recipes: Recipes;
  /** The red proof step of the recipe `recipe`, when it has one (ADR 0078). */
  redProof?: (recipe: string) => string | undefined;
}

/** How much of a model's text is read for secrets: what `plain` shows, and room past it. */
const scanned = 1_000;
/** How many findings of one step, and dispositions in all, the brief lists. */
const mostFindings = 10;
const mostDispositions = 30;
/**
 * How long the brief after its title may be: below GitHub's 65,536 characters for a comment, with
 * room for the title (`plain` keeps it to 200 characters, five times as long escaped) and the
 * marker. The title is left out, so a brief found by its marker can be told by the rest.
 */
const longestRest = 60_000;

/** A text a brewer wrote at `stepId` as one inert line (ADR 0088, ADR 0184). */
type Told = (text: string, stepId: string) => string;

/** The attempt of `stepId` with the highest number. */
const latestOf = (batch: Batch, stepId: string): Attempt | undefined => {
  const attempts = batch.steps.get(stepId)?.attempts;
  return attempts === undefined ? undefined : attempts.get(Math.max(...attempts.keys()));
};

/** The output of the latest attempt of `stepId` when it finished and succeeded. */
const succeededOutput = (batch: Batch, stepId: string): { output: unknown } | undefined => {
  const latest = latestOf(batch, stepId);
  return latest?.phase === 'finished' && latest.outcome.kind === 'succeeded'
    ? { output: latest.outcome.output }
    : undefined;
};

/** Where `{stepId, attempt}` is on the batch's path; -1 when it never started. */
const placeOnPath = (batch: Batch, stepId: string, attempt: number): number =>
  (batch.path ?? []).findIndex((each) => each.stepId === stepId && each.attempt === attempt);

/** The attempts a pull request's failure sent back, in the order they started (ADR 0219). */
const fixRounds = (batch: Batch): { stepId: string; attempt: Attempt; at: number }[] =>
  [...batch.steps.values()]
    .flatMap((step) =>
      [...step.attempts.values()]
        .filter(({ route }) => route?.why === 'pull_request')
        .map((attempt) => ({
          stepId: step.id,
          attempt,
          at: placeOnPath(batch, step.id, attempt.attempt),
        })),
    )
    .sort((a, b) => a.at - b.at);

/** What changed since the pull request opened: each fix round, its failed head and its push. */
const changedLines = (state: State, batch: Batch): string[] => {
  const pushes = recordedPushes(state, batch.id);
  const lines = fixRounds(batch).map(({ attempt }, i) => {
    const round = i + 2;
    const failed = attempt.route?.why === 'pull_request' ? attempt.route.head : '';
    const pushed = PushResult.safeParse(pushes[round - 1]);
    const after = pushed.success
      ? `it pushed ${code(shortSha(pushed.data.commit))}`
      : 'it pushed nothing yet';
    return `- Round ${round}: the checks failed on ${code(shortSha(failed))}, and ${after}.`;
  });
  return lines.length === 0 ? ['- Nothing.'] : lines;
};

/** Each check of the ready record, as the Stuck reason writes them, and how many more passed. */
const checkLines = ({ checks, more }: ReadyRecord): string[] => {
  if (checks.length === 0 && more === undefined) return ['- No check ran on this head.'];
  // A check's name and link are whoever runs CI's words (ADR 0213).
  return [
    ...checks.map(
      ({ name, conclusion, url }) =>
        `- ✅ ${plain(name)} (${conclusion})${url === undefined ? '' : ` ${link(url)}`}`,
    ),
    ...(more === undefined ? [] : [`- and ${more} more checks, which passed`]),
  ];
};

/** How the pull request merges with its base, by its latest base check (ADR 0198, ADR 0203). */
const baseLine = (batch: Batch, url: string): string => {
  const latest = batch.baseChecks?.filter((check) => check.pullRequest === url).at(-1);
  if (latest === undefined) return '- Not checked against its base since it was pushed.';
  const at = `${code(latest.branch)} at ${code(shortSha(latest.tip))}`;
  if (latest.unchecked !== undefined) {
    return `- Not checked on the merged tree with ${at}: ${plain(latest.unchecked)}.`;
  }
  return `- Merges cleanly with ${at}.`;
};

/** The readings of a check step's latest success, its repository's setup left out (ADR 0163). */
const checkReadings = (batch: Batch, stepId: string): readonly GravityReading[] | undefined => {
  const latest = latestOf(batch, stepId);
  if (latest?.phase !== 'finished' || latest.outcome.kind !== 'succeeded') return undefined;
  const readings = (latest.readings ?? []).filter(
    (reading) => reading.result === 'skipped' || reading.setup !== true,
  );
  return readings.length === 0 ? undefined : readings;
};

/** The facts of one batch's steps the brief reads, in its recipe's order. */
interface Steps {
  batch: Batch;
  recipe: Recipe | undefined;
  ids: readonly string[];
}

/** The `when` that was false for `stepId`, or its group's, when the batch skipped it (ADR 0064). */
const skippedBy = ({ batch, recipe }: Steps, stepId: string): { when?: string } | undefined => {
  const group = recipe?.group(stepId);
  const skipped = batch.skipped?.has(stepId) === true;
  const groupSkipped = group !== undefined && batch.skipped?.has(group) === true;
  if (!skipped && !groupSkipped) return undefined;
  const when = recipe?.skip(batch, skipped ? stepId : (group ?? stepId));
  return when === undefined ? {} : { when };
};

const notRunText = ({ when }: { when?: string }): string =>
  when === undefined ? 'not run' : `not run: its when "${plain(when)}" was false`;

/** The red proof's row: its readings, not run and why, or that the recipe has none. */
const redProofLine = (steps: Steps, proof: string | undefined): string => {
  if (proof === undefined) return '- Red proof: none in the recipe.';
  const skipped = skippedBy(steps, proof);
  if (skipped !== undefined) return `- Red proof ${code(proof)}: ${notRunText(skipped)}.`;
  const readings = checkReadings(steps.batch, proof);
  if (readings === undefined) return `- Red proof ${code(proof)}: not run.`;
  const read = readings.map((reading) => plain(readingText(reading))).join('; ');
  return `- Red proof ${code(proof)}: ${read}, as the new tests should before the change.`;
};

/** Each other check step's latest success: the checks it read, and the ones it skipped. */
const checkStepLines = (steps: Steps, proof: string | undefined): string[] =>
  steps.ids.flatMap((stepId) => {
    if (stepId === proof) return [];
    const readings = checkReadings(steps.batch, stepId);
    if (readings === undefined) return [];
    const read = readings.filter(({ result }) => result !== 'skipped').map(checkOf);
    const skipped = readings.filter(({ result }) => result === 'skipped').map(checkOf);
    const passed =
      read.length === 0
        ? `- ${code(stepId)} ran no check.`
        : `- ${code(stepId)} passed: ${plain(read.join(', '))}.`;
    return [
      skipped.length === 0
        ? passed
        : `${passed} Not run: ${plain(skipped.join(', '))}, which the repository does not have.`,
    ];
  });

/** How an attempt that did not succeed ended, in words. */
const endedText = (attempt: Attempt): string => {
  if (attempt.phase !== 'finished') return 'did not finish';
  switch (attempt.outcome.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'needs_input':
      return 'asked for input';
    case 'cancelled':
      return 'was stopped';
    default:
      return attempt.outcome satisfies never;
  }
};

/**
 * Each step that did not run, with the `when` that was false, and each whose latest attempt did not
 * succeed that a person's skip went past; a step blocked by findings is the Findings section's.
 */
const notRunLines = (steps: Steps, proof: string | undefined): string[] =>
  steps.ids.flatMap((stepId) => {
    if (stepId === proof || steps.recipe?.action(stepId) !== undefined) return [];
    const skipped = skippedBy(steps, stepId);
    if (skipped !== undefined) return [`- ${code(stepId)}: ${notRunText(skipped)}.`];
    const latest = latestOf(steps.batch, stepId);
    if (latest === undefined) return [`- ${code(stepId)}: not run.`];
    if (latest.phase === 'finished' && latest.outcome.kind === 'succeeded') return [];
    if (latest.phase === 'finished' && onFindings(latest.outcome)) return [];
    return [
      `- ${code(stepId)}: did not pass: its attempt ${latest.attempt} ${endedText(latest)}, and a person's skip went past it.`,
    ];
  });

/** The Taster's steps of the batch, in its recipe's order: a verdict, or blocked by findings. */
const tastingSteps = ({ batch, ids }: Steps): string[] =>
  ids.filter((stepId) =>
    [...(batch.steps.get(stepId)?.attempts.values() ?? [])].some(
      (attempt) =>
        attempt.phase === 'finished' &&
        (onFindings(attempt.outcome) ||
          (attempt.outcome.kind === 'succeeded' &&
            tastingOf(attempt.outcome.output) !== undefined)),
    ),
  );

/**
 * The last tasting step in the recipe's order, or each child of its parallel group (ADR 0214): the
 * steps whose risk left the brief shows.
 */
const lastTasters = (steps: Steps): string[] => {
  const tasters = tastingSteps(steps);
  const last = tasters.at(-1);
  if (last === undefined) return [];
  const group = steps.recipe?.group(last);
  return group === undefined ? [last] : tasters.filter((id) => steps.recipe?.group(id) === group);
};

/** Where the last Taster tasted, and the fix rounds since, from the log alone. */
const tastedLine = (steps: Steps, ready: ReadyRecord): string => {
  const [last] = lastTasters(steps);
  const attempt = last === undefined ? undefined : latestOf(steps.batch, last);
  if (last === undefined || attempt === undefined) return '- No Taster tasted this change.';
  const commit = attempt.phase === 'scheduled' ? undefined : attempt.worktree?.commit;
  if (commit === undefined) return '- Tasted at a commit the log does not record.';
  if (commit === ready.head) return `- Tasted at ${code(shortSha(commit))}, this head.`;
  const at = placeOnPath(steps.batch, last, attempt.attempt);
  const since = fixRounds(steps.batch).filter((round) => round.at > at).length;
  return `- Tasted at ${code(shortSha(commit))}; ${since} fix round${since === 1 ? '' : 's'} since.`;
};

/**
 * The findings each round of a Taster's step left: a success's from its out doc, a blocked round's
 * as `step.finished` recorded them (ADR 0221).
 */
const roundFindings = (ran: LensRound['ran']): readonly TastingFinding[] =>
  ran.outcome.kind === 'succeeded'
    ? (tastingOf(ran.outcome.output)?.findings ?? [])
    : (ran.findings?.kept ?? []);

/**
 * What the step each findings route went back to did with each finding (ADR 0191), round by round
 * in the order they ran, each after the lens of the finding at its place, the first not already
 * taken, as a later round's input pairs them (ADR 0220).
 */
const dispositionLines = (steps: Steps, told: Told): string[] => {
  const lines = tastingSteps(steps).flatMap((stepId) =>
    lensRounds(steps.batch, stepId).flatMap(({ ran, dispositions }) => {
      const left = [...roundFindings(ran)];
      return dispositions.map((found) => {
        const at = left.findIndex(({ file, line }) => file === found.file && line === found.line);
        const [finding] = at < 0 ? [] : left.splice(at, 1);
        const lens = finding === undefined ? '' : lensFirst(finding);
        const why = found.why === undefined ? '' : `: ${told(found.why, stepId)}`;
        return `- ${code(stepId)}: ${lens}${found.disposition} at ${told(placeOf(found), stepId)}${why}`;
      });
    }),
  );
  const more = lines.length - mostDispositions;
  return more > 0 ? [...lines.slice(0, mostDispositions), `- and ${more} more`] : lines;
};

/** The findings of each Taster's step whose latest attempt succeeded: advisory, left open. */
const openLines = (steps: Steps, told: Told): string[] =>
  steps.ids.flatMap((stepId) =>
    capped(
      stepId,
      tastingOf(succeededOutput(steps.batch, stepId)?.output)?.findings ?? [],
      mostFindings,
      (finding) => `open: ${told(findingText(finding), stepId)}: ${told(finding.why, stepId)}`,
    ),
  );

/**
 * Each blocking Taster's step blocked by its findings that a person's skip went past, and each
 * finding its round recorded (ADR 0221), which the skip accepted.
 */
const skippedOpenLines = (steps: Steps, told: Told): string[] =>
  steps.ids.flatMap((stepId) => {
    const latest = latestOf(steps.batch, stepId);
    if (latest?.phase !== 'finished' || !onFindings(latest.outcome)) return [];
    const left = `- ${code(stepId)}: left open by a skip`;
    const { kept = [], more = 0 } = latest.findings ?? {};
    const shown = kept.slice(0, mostFindings);
    const rest = kept.length + more - shown.length;
    return [
      `${left}: its attempt ${latest.attempt} was blocked by its findings`,
      ...shown.map(
        (finding) => `${left}: ${told(findingText(finding), stepId)}: ${told(finding.why, stepId)}`,
      ),
      ...(rest > 0 ? [`${left}: and ${rest} more`] : []),
    ];
  });

/** The last Taster's risk left, each item after its step (ADR 0214). */
const riskLines = (steps: Steps, told: Told): string[] =>
  lastTasters(steps).flatMap((stepId) =>
    (tastingOf(succeededOutput(steps.batch, stepId)?.output)?.riskLeft ?? []).map(
      (risk) => `- ${code(stepId)}: ${told(risk, stepId)}`,
    ),
  );

/** `text` cut to whole lines below `longestRest`, as `renderStatus` cuts. */
const cut = (text: string): string => {
  if (text.length <= longestRest) return text;
  const note = '\n\n… the rest is cut: GitHub keeps comments shorter.';
  const kept = text.slice(0, longestRest - note.length);
  return `${kept.slice(0, kept.lastIndexOf('\n'))}${note}`;
};

/** The brief after its title line, for `ready`, the record that makes `batch` ready. */
const briefRest = (
  state: State,
  batch: Batch,
  ready: ReadyRecord,
  recipes: Recipes,
  redProof: (recipe: string) => string | undefined,
): string => {
  const isCommit: IsCommit = knownCommits(state, batch.id);
  // Only what can be shown is read, on one line: then no secret, no keyword or mention, no markup.
  const told: Told = (text, stepId) =>
    plain(
      unlinked(
        withoutSecrets(text.replace(/\s+/g, ' ').trim().slice(0, scanned), stepId, isCommit),
      ),
    );
  const name = batch.recipe?.name;
  const recipe = name === undefined ? undefined : recipes.find(name);
  const steps: Steps = {
    batch,
    recipe,
    ids: [...new Set([...(recipe?.steps ?? []), ...batch.steps.keys()])],
  };
  const proof = name === undefined ? undefined : redProof(name);
  const head = code(shortSha(ready.head));
  const sensitive = latestPush(state, batch.id)?.sensitive;
  const findings = [
    ...dispositionLines(steps, told),
    ...openLines(steps, told),
    ...skippedOpenLines(steps, told),
  ];
  const risks = riskLines(steps, told);
  const sections = [
    [`Foedrum · batch ${code(batch.id)} · ${link(ready.pullRequest)}`],
    [
      `**Ready to merge.** Every check on ${head} finished and passed, and nothing else is open on it. Foedrum does not merge it: it waits for whoever merges this pull request.`,
    ],
    ['**What changed since it opened**', ...changedLines(state, batch)],
    [
      `**Evidence on ${head}**`,
      ...checkLines(ready),
      baseLine(batch, ready.pullRequest),
      redProofLine(steps, proof),
      ...checkStepLines(steps, proof),
      ...notRunLines(steps, proof),
      tastedLine(steps, ready),
      ...(sensitive === undefined ? [] : [`- ${sensitiveLine(sensitive)}.`]),
    ],
    ['**Findings**', ...(findings.length === 0 ? ['No finding was recorded.'] : findings)],
    ['**Risk left**', ...(risks.length === 0 ? ['None recorded.'] : risks)],
  ];
  return cut(sections.map((lines) => lines.join('\n')).join('\n\n'));
};

/** The brief's title line: the pull request's title, which anyone who can edit it wrote. */
const titleLine = (title: string, head: string): string =>
  `### Merge? ${plain(title)} @ ${code(shortSha(head))}`;

/**
 * The hidden line before a brief's marker that names the record it was posted for: what tells a
 * brief a killed driver posted from another record's under the same key. No model text can write
 * it, since `plain` writes each `<` as `&lt;`.
 */
const recordLine = ({ pullRequest, head, digest }: ReadyRecord): string =>
  `<!-- foedrum:brief ${new URL(pullRequest).href} ${head} ${digest} -->`;

/** What a brief of `ready` under `key` ends with: its record's line, then its marker. */
const endOf = (key: string, ready: ReadyRecord): string =>
  `\n\n${recordLine(ready)}\n${effectMarker(key)}`;

/** A brief that is due: where it goes, what follows its title, and the record it is for. */
interface DueBrief {
  repo: string;
  number: number;
  rest: string;
  ready: ReadyRecord;
}

/** A brief's ledger result, checked: the id comes from the code host, and the ledger keeps it. */
const resultOf = (comment: number, { pullRequest, head, digest }: ReadyRecord): MergeBrief => {
  const parsed = MergeBrief.safeParse({ comment, pullRequest, head, digest });
  if (!parsed.success) {
    throw new Error(`The code host answered a comment id that is no positive integer: ${comment}`);
  }
  return parsed.data;
};

/**
 * The merge brief of each ready pull request, for the driver (ADR 0225): due when `readyOf` gives a
 * record the latest brief was not posted for, found among the Brewery's own comments by its record's
 * line and its marker, else posted.
 */
export const mergeBriefEffects = (options: MergeBriefEffectsOptions): DriverEffects => {
  const { host, recipes, redProof = () => undefined } = options;
  // The brief behind each key `due` gave; the driver asks `due` before it applies a key.
  const briefs = new Map<string, DueBrief>();
  const briefFor = (key: string): DueBrief => {
    const due = briefs.get(key);
    if (due === undefined) throw new Error(`No merge brief ${key} is due`);
    return due;
  };
  const target: EffectTarget = {
    find: async (key, signal) => {
      const { repo, number, ready } = briefFor(key);
      // By the record alone: another record's brief a killed driver posted under this key stays,
      // and a base that moved since changes the text, not the record.
      const found = await host.find(repo, number, endOf(key, ready), signal);
      return found === undefined ? undefined : { result: resultOf(found.id, ready) };
    },
    apply: async (key, signal) => {
      const { repo, number, rest, ready } = briefFor(key);
      const title = await host.title(repo, number, signal);
      const body = `${titleLine(title, ready.head)}\n\n${rest}${endOf(key, ready)}`;
      return resultOf(await host.create(repo, number, body, signal), ready);
    },
  };
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      const ready = batch === undefined ? undefined : readyOf(state, batch);
      if (batch === undefined || ready === undefined) return [];
      const { next, latest } = latestBrief(state, batchId);
      if (briefOf(latest, ready)) return [];
      let where: { repo: string; number: number };
      try {
        where = pullRequestOf(ready.pullRequest);
      } catch {
        return [];
      }
      const key = briefKey(batchId, next);
      const rest = briefRest(state, batch, ready, recipes, redProof);
      briefs.set(effectKey.encode(key), { ...where, rest, ready });
      return [key];
    },
    target,
  };
};
