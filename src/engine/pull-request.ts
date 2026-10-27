// The openPullRequest action (ADR 0071), the pure core: the keys of its two effects, the bottle
// branch it pushes, the pull request the ledger recorded, and the pull request's text from the
// order and the brewers' out docs.

import { createHash } from 'node:crypto';
import type { IsCommit } from '../formats/secrets.ts';
import {
  type Disposition,
  dispositionsOf,
  type FiningChange,
  FiningOutDoc,
  type FiningReport,
  finingOf,
  GaugeOutDoc,
  type GaugeReport,
  gaugeOf,
  lensFirst,
  OutDocFrontmatter,
  PullRequestOutDoc,
  type PullRequestSections,
  placeOf,
  pullRequestSectionsOf,
  type TastingFinding,
  TastingOutDoc,
  type TastingReport,
  tastingOf,
} from '../schemas/out-doc.ts';
import { type BatchEffectKey, BodyResult, PushResult } from '../schemas/store.ts';
import { repoFolder } from '../workspace/attempt-worktrees.ts';
import { effectKey } from './effect-key.ts';
import type { Batch, State, Step } from './fold.ts';
import { withoutSecrets } from './out-doc-text.ts';

/**
 * The effect that pushes the batch's task tree to its bottle branch in `round` of its pull request:
 * `push` in the first, as before rounds were, then `push.<n>` (ADR 0219).
 */
export const pushKey = (batchId: string, round = 1): BatchEffectKey => ({
  batchId,
  effect: round === 1 ? 'push' : `push.${round}`,
});

/**
 * The round of the batch's pull request: 1, and one more each time a failure on it sent the batch
 * back (ADR 0219).
 */
export const pullRequestRound = (batch: Batch): number => {
  let round = 1;
  for (const step of batch.steps.values()) {
    for (const attempt of step.attempts.values()) {
      if (attempt.route?.why === 'pull_request') round++;
    }
  }
  return round;
};

/**
 * What the ledger recorded for each push of `batchId`, round by round from the first, as far as
 * they go: a round pushes only after the one before (ADR 0219).
 */
export const recordedPushes = (state: State, batchId: string): unknown[] => {
  const recorded: unknown[] = [];
  for (let round = 1; ; round++) {
    const key = effectKey.encode(pushKey(batchId, round));
    if (!state.effects.has(key)) return recorded;
    recorded.push(state.effects.get(key));
  }
};

/** The latest push the ledger recorded for `batchId` (ADR 0219), when it is one the engine records. */
export const latestPush = (state: State, batchId: string): PushResult | undefined => {
  const parsed = PushResult.safeParse(recordedPushes(state, batchId).at(-1));
  return parsed.success ? parsed.data : undefined;
};

/** The effect that opens the batch's pull request, once per batch. */
export const pullRequestKey = (batchId: string): BatchEffectKey => ({
  batchId,
  effect: 'pull_request',
});

/**
 * The effect that writes the batch's pull request body in `round`: the open's in the first, then
 * `body.<n>`, which renders it again (ADR 0227).
 */
export const bodyKey = (batchId: string, round: number): BatchEffectKey =>
  round === 1 ? pullRequestKey(batchId) : { batchId, effect: `body.${round}` };

/** The text a body marker's digest is of: its line endings made `\n`, its end trimmed. */
const normalized = (text: string): string => text.replace(/\r\n?/g, '\n').trimEnd();

/** The first 16 hex digits of the SHA-256 of `text`, as a status comment's revision has (ADR 0072). */
export const digestOf = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The marker line that ends a body Foedrum wrote: its key, and the digest of `text` above it. */
const bodyMarker = (key: BatchEffectKey, text: string): string =>
  `<!-- foedrum:${effectKey.encode(key)} sha256:${digestOf(normalized(text))} -->`;

const MARKER_LINE = /^<!-- foedrum:(\[.*\]) sha256:([0-9a-f]{16}) -->$/;

/** The key and digest of `line` when it is a body marker of `batchId`. */
const markerOf = (batchId: string, line: string): { key: string; digest: string } | undefined => {
  const [, key = '', digest = ''] = MARKER_LINE.exec(line) ?? [];
  try {
    return effectKey.decode(key).batchId === batchId ? { key, digest } : undefined;
  } catch {
    return undefined;
  }
};

/** Whose a pull request's body is (ADR 0227): Foedrum's own, with its marker, or left alone. */
export type BodyOwner =
  | { kind: 'own'; key: string; digest: string }
  | { kind: 'left'; left: 'edited' | 'unmarked' };

/**
 * Whose the body of `batchId`'s pull request is (ADR 0227): Foedrum's own when its last line is a
 * marker of the batch and the digest of the text above it matches, line endings made `\n`: only the
 * last line, so a marker a brewer wrote into how it works never passes for it.
 */
export const bodyOwner = (batchId: string, body: string): BodyOwner => {
  const text = normalized(body);
  const at = text.lastIndexOf('\n');
  const last = markerOf(batchId, text.slice(at + 1));
  if (last !== undefined && digestOf(text.slice(0, Math.max(0, at)).trimEnd()) === last.digest) {
    return { kind: 'own', ...last };
  }
  // A marker of the batch on another line: the text after it changed, or it moved.
  const marked = text.split('\n').some((line) => markerOf(batchId, line.trim()) !== undefined);
  return { kind: 'left', left: marked ? 'edited' : 'unmarked' };
};

/** What the latest round's body effect recorded (ADR 0227), for a round after the first. */
export const latestBody = (state: State, batchId: string): BodyResult | undefined => {
  const round = recordedPushes(state, batchId).length;
  if (round < 2) return undefined;
  const parsed = BodyResult.safeParse(state.effects.get(effectKey.encode(bodyKey(batchId, round))));
  return parsed.success ? parsed.data : undefined;
};

/** The local name of the batch's bottle branch in `repo`: `foedrum/<batch>/<owner>.<name>`. */
export const bottleBranch = (batchId: string, repo: string): string =>
  `foedrum/${batchId}/${repoFolder(repo)}`;

/** The pull request the ledger recorded for `batchId`, by its URL, or `undefined`. */
export const openedPullRequest = (state: State, batchId: string): string | undefined => {
  const result = state.effects.get(effectKey.encode(pullRequestKey(batchId)));
  return typeof result === 'string' ? result : undefined;
};

/**
 * The open pull request of `batch` that its ledger opened, with the commit and the bottle branch
 * its push recorded; `undefined` also once someone else pushed to that branch (ADR 0198).
 */
export const openOf = (
  state: State,
  batch: Batch,
): { url: string; head: string; branch: string } | undefined => {
  const { lane } = batch;
  const url = openedPullRequest(state, batch.id);
  if (lane.kind !== 'on_tap' || url === undefined || !lane.pullRequests.includes(url)) {
    return undefined;
  }
  if (batch.pullRequestEnds?.[url] !== undefined) return undefined;
  const moved = batch.baseChecks?.some(
    (check) => check.pullRequest === url && check.branchMoved !== undefined,
  );
  if (moved === true) return undefined;
  // A round that found the branch moved or gone pushed nothing: the pull request is left alone.
  const pushed = latestPush(state, batch.id);
  if (
    pushed === undefined ||
    pushed.empty === true ||
    pushed.refused !== undefined ||
    pushed.moved !== undefined ||
    pushed.gone === true
  ) {
    return undefined;
  }
  return { url, head: pushed.commit, branch: pushed.branch };
};

/**
 * The commits the state records for `batchId`, which a 40-character hexadecimal word may name
 * without being a key (ADR 0088): where its attempts' worktrees started, its rewinds' commits, and
 * the commit each push recorded, the commits it refused (ADR 0079) and the commit it found the
 * branch moved to (ADR 0219). Read from the folded state,
 * never from git.
 */
export const knownCommits = (state: State, batchId: string): IsCommit => {
  const batch = state.batches.get(batchId);
  const commits = new Set<string>();
  for (const step of batch?.steps.values() ?? []) {
    for (const attempt of step.attempts.values()) {
      if (attempt.phase !== 'scheduled' && attempt.worktree !== undefined) {
        commits.add(attempt.worktree.commit);
      }
    }
  }
  for (const rewind of batch?.rewinds ?? []) {
    for (const sha of Object.values(rewind.shas)) commits.add(sha);
  }
  for (const recorded of recordedPushes(state, batchId)) {
    const pushed = PushResult.safeParse(recorded);
    if (!pushed.success) continue;
    commits.add(pushed.data.commit);
    for (const { commit } of pushed.data.refused ?? []) commits.add(commit);
    if (pushed.data.moved !== undefined) commits.add(pushed.data.moved);
  }
  return (word) => commits.has(word);
};

/** A finding left as there before the change (ADR 0191). */
type PreExisting = Extract<Disposition, { disposition: 'pre-existing' }>;

/** What a step reported in the out doc of its latest attempt that succeeded. */
export interface StepReport {
  stepId: string;
  summary: string;
  assumptions: readonly string[];
  /** A Taster's verdict and findings (ADR 0161). */
  tasting?: TastingReport;
  /** The pull request's sections a `pullRequest` brewer wrote (ADR 0167). */
  sections?: PullRequestSections;
  /** A Finer's changes, or why there was nothing to simplify (ADR 0166). */
  fining?: FiningReport;
  /** The new tests and the regression tests a Gauger named (ADR 0170). */
  gauge?: GaugeReport;
  /** The findings its attempts marked pre-existing, for a person to file (ADR 0191). */
  toFile?: readonly PreExisting[];
}

/** One finished attempt of a batch, as the pull request's brew table shows it (ADR 0167). */
export interface AttemptRow {
  stepId: string;
  attempt: number;
  /** The engine's word for how it ended, or a Taster's verdict. */
  result: string;
  /** Why a failed attempt failed: the engine's text, which may quote a model's words. */
  reason?: string;
}

/** The finished attempts of `batch`, in the order they started (`Batch.path`). */
export const brewLog = (batch: Batch): AttemptRow[] =>
  (batch.path ?? []).flatMap(({ stepId, attempt }): AttemptRow[] => {
    const ran = batch.steps.get(stepId)?.attempts.get(attempt);
    if (ran === undefined) return [];
    // A running attempt, the action's own among them, has no result yet.
    if (ran.phase !== 'finished') {
      return ran.abandoned === true ? [{ stepId, attempt, result: 'abandoned' }] : [];
    }
    const { outcome } = ran;
    switch (outcome.kind) {
      case 'succeeded':
        return [{ stepId, attempt, result: tastingOf(outcome.output)?.verdict ?? 'succeeded' }];
      case 'failed':
        return [{ stepId, attempt, result: 'failed', reason: outcome.reason }];
      case 'needs_input':
        return [{ stepId, attempt, result: 'needs input' }];
      case 'cancelled':
        return [{ stepId, attempt, result: 'cancelled' }];
      default:
        return outcome satisfies never;
    }
  });

// A keyword after anything but an ASCII letter or digit, the word boundary GitHub reads: emphasis
// with `_` around it starts a word once GitHub renders it (`_fixes #3_`), and so does `é`.
const KEYWORD =
  /(?<![A-Za-z0-9])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[^A-Za-z0-9]*(?=#|GH-|[\w.-]+\/[\w.-]+#|https?:)/giu;
const MENTION = /(^|[^A-Za-z0-9])@(?=[A-Za-z0-9])/gu;
// Every character reference GitHub would decode, named or numeric: `&commat;` is an `@`.
const REFERENCE = /&(?!amp;)(?=[#\p{L}])/gu;

/** A line break as CommonMark reads one, kept by `split`: `\r\n`, `\r` or `\n`. */
const BREAK = /(\r\n|\r|\n)/;
/** A blank line, which ends every paragraph, and so every span and HTML tag in one. */
const BLANK = /^[ \t]*$/;
/**
 * What GitHub may read before a span, taking a backtick from it: an HTML tag or an autolink (`<`),
 * a link's destination or title (`]`), and its math (`$`).
 */
const BEFORE_SPANS = /[<\]$]/;

/**
 * Where `text`'s code spans start and end, paired as CommonMark pairs them but within one line
 * (ADR 0184): a run of backticks no backslash escapes, and the next run as long. Where GitHub could
 * read a span as text, there is none: after a span that holds a `|`, which a table splits first,
 * on a line with what GitHub may read before a span, and on the lines after a run left open, such
 * a line or a `|` until a blank line, since a span or a tag can go on over them.
 */
const codeSpans = (text: string): [start: number, end: number][] => {
  const spans: [number, number][] = [];
  let index = 0;
  let open = false;
  for (const [part, line] of text.split(BREAK).entries()) {
    const start = index;
    index += line.length;
    if (part % 2 === 1) continue;
    if (BLANK.test(line)) open = false;
    if (open) continue;
    if (BEFORE_SPANS.test(line)) {
      open = true;
      continue;
    }
    for (let at = 0; at < line.length; ) {
      // A backslash escapes the character after it, a backtick too, outside a span.
      if (line[at] === '\\') {
        at += 2;
        continue;
      }
      if (line[at] !== '`') {
        at += 1;
        continue;
      }
      const opener = /`+/y;
      opener.lastIndex = at;
      const run = opener.exec(line)?.[0] ?? '`';
      const closer = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
      closer.lastIndex = at + run.length;
      const close = closer.exec(line);
      // A run with no partner on its line may have one on the next: the line goes on pairing.
      if (close === null) {
        open = true;
        at += run.length;
        continue;
      }
      const end = close.index + run.length;
      if (line.slice(at, end).includes('|')) {
        open = true;
        break;
      }
      spans.push([start + at, start + end]);
      at = end;
    }
  }
  return spans;
};

/** `text` with `edit` applied to what lies outside its code spans. */
const outsideSpans = (text: string, edit: (part: string) => string): string => {
  let out = '';
  let from = 0;
  for (const [start, end] of codeSpans(text)) {
    out += edit(text.slice(from, start)) + text.slice(start, end);
    from = end;
  }
  return out + edit(text.slice(from));
};

/**
 * Model text without what GitHub would act on outside a fence (ADR 0167): the `@` of a mention,
 * a closing keyword before an issue reference, and the `&` of a character reference, except inside
 * a code span, where GitHub acts on none of them (ADR 0184).
 */
export const unlinked = (text: string): string => {
  // A removal can make what it removes again: `closes closes #3`, `@@ann`, `&@ann`. The spans are
  // paired again each time, in case a removal changes how a line pairs.
  let out = text;
  for (let before = ''; before !== out; ) {
    before = out;
    out = outsideSpans(out, (part) =>
      part.replace(REFERENCE, '&amp;').replace(MENTION, '$1').replace(KEYWORD, ''),
    );
  }
  return out;
};

/**
 * Whether the pull request opens as a draft (ADR 0167): unless a Taster tasted the change and
 * every Taster approved.
 */
export const opensAsDraft = (reports: readonly StepReport[]): boolean => {
  const verdicts = reports.flatMap(({ tasting }) =>
    tasting === undefined ? [] : [tasting.verdict],
  );
  return verdicts.length === 0 || verdicts.some((verdict) => verdict !== 'approve');
};

/** The reports of `batch`'s steps, in the order they were first scheduled. */
export const stepReports = (batch: Batch): StepReport[] =>
  [...batch.steps.values()].flatMap((step) => {
    const latest = [...step.attempts.values()]
      .filter((attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded')
      .at(-1);
    if (latest?.phase !== 'finished' || latest.outcome.kind !== 'succeeded') return [];
    // A check's success has no out doc; a Taster's has its verdict and findings too (ADR 0161),
    // a pullRequest brewer's the pull request's sections (ADR 0167), a Finer's its changes
    // (ADR 0166), and a Gauger's its tests (ADR 0170).
    const { output } = latest.outcome;
    const doc = OutDocFrontmatter.or(TastingOutDoc)
      .or(PullRequestOutDoc)
      .or(FiningOutDoc)
      .or(GaugeOutDoc)
      .safeParse(output);
    if (!doc.success) return [];
    const { summary, assumptions } = doc.data;
    const tasting = tastingOf(output);
    const sections = pullRequestSectionsOf(output);
    const fining = finingOf(output);
    const gauge = gaugeOf(output);
    const toFile = preExistingOf(step);
    return [
      {
        stepId: step.id,
        summary,
        assumptions,
        ...(tasting === undefined ? {} : { tasting }),
        ...(sections === undefined ? {} : { sections }),
        ...(fining === undefined ? {} : { fining }),
        ...(gauge === undefined ? {} : { gauge }),
        ...(toFile.length === 0 ? {} : { toFile }),
      },
    ];
  });

/**
 * The findings the succeeded attempts of `step` marked pre-existing (ADR 0191), in order, each
 * place and why once: every round's, since a later round never raises one again.
 */
const preExistingOf = (step: Step): PreExisting[] => {
  const seen = new Set<string>();
  return [...step.attempts.values()].flatMap((attempt) => {
    if (attempt.phase !== 'finished' || attempt.outcome.kind !== 'succeeded') return [];
    return dispositionsOf(attempt.outcome.output).filter((found): found is PreExisting => {
      const key = JSON.stringify([found.file, found.line, found.why]);
      if (found.disposition !== 'pre-existing' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
};

/**
 * Where a finding is, how bad, and whether it was there before the change, on one line, after its
 * lens when it names one.
 */
export const findingText = (finding: TastingFinding): string => {
  const { file, line, severity, introduced } = finding;
  const where = file === undefined ? '' : ` in ${file}${line === undefined ? '' : `:${line}`}`;
  // The lens it was found through, on a step of several lenses together (ADR 0220).
  return `${lensFirst(finding)}${severity}${where}${introduced ? '' : ', there before the change'}`;
};

/** Where a Finer's change is: its file, and its line when it has one. */
export const changeText = ({ file, line }: FiningChange): string =>
  line === undefined ? file : `${file}:${line}`;

export interface PullRequestTextInput {
  /** The title of the order's issue: untrusted. */
  title: string;
  /** The order's issue, which the pull request closes. */
  closes: { repo: string; issue: number };
  /** Model output: untrusted. */
  reports: readonly StepReport[];
  /** Whether a 40-character hexadecimal word is a commit, not a key; none is when absent. */
  isCommit?: IsCommit;
  /** The recipe the batch brewed with. */
  recipe?: string;
  /** The batch's finished attempts, for the brew table (ADR 0167). */
  attempts?: readonly AttemptRow[];
  /** The effect that writes the body, which its last line names with a marker (ADR 0227). */
  key?: BatchEffectKey;
}

export interface PullRequestText {
  title: string;
  body: string;
  /** Opened as a draft (ADR 0167): unless every Taster approved and how it works is written. */
  draft: boolean;
}

/** GitHub's longest title of a pull request. */
const MAX_TITLE = 256;
/** GitHub's longest body of a pull request. */
const MAX_BODY = 65_536;
/** The longest the reports are, when the sections leave room (ADR 0167). */
const MAX_REPORTS = 25_000;
/** Room for the lines around the reports: the details, the fences and the cut. */
const FRAME = 200;
const CUT = '(cut short)';
/** How far past the cut a text is read for secrets: room for a match that starts before it. */
const SCAN_PAST = 1_000;
/** The most attempts the brew table lists, and the longest a reason or a cell it shows. */
const MAX_ATTEMPTS = 50;
const MAX_CELL = 200;

/** The control characters, and the line and paragraph separators, which end a line. */
const UNPRINTABLE = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}${String.fromCodePoint(0x2028, 0x2029)}]`,
  'g',
);

/** The line breaks and control characters of `text` as `\uXXXX` escapes, as `foedrum brew` shows. */
const escapedLine = (text: string): string =>
  text.replace(UNPRINTABLE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** `text` in a code span longer than any run of backticks in it, every pipe escaped for a table. */
const codeCell = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(longest + 1);
  // A pipe after an even run of backslashes ends the cell, in a code span too.
  const piped = text.replace(/(\\*)\|/g, (all, slashes: string) =>
    slashes.length % 2 === 0 ? `${slashes}\\|` : all,
  );
  return `${fence} ${piped} ${fence}`;
};

/** The table of the batch's finished attempts, and a count of those it leaves out. */
const brewTable = (attempts: readonly AttemptRow[], isCommit: IsCommit): string => {
  const rows = attempts.slice(0, MAX_ATTEMPTS).map(({ stepId, attempt, result, reason }) => {
    const why =
      reason === undefined
        ? ''
        : `: ${codeCell(
            escapedLine(withoutSecrets(reason.slice(0, MAX_CELL + SCAN_PAST), stepId, isCommit))
              // A long run of backticks would make the code span's fence as long.
              .replace(/`{4,}/g, '```')
              .slice(0, MAX_CELL),
          )}`;
    // A code span, as the status comment writes it: GitHub links a bare `#1` to issue 1 (ADR 0184).
    return `| \`${stepId} #${attempt}\` | ${result}${why} |`;
  });
  const more = attempts.length - rows.length;
  return [
    ['| Attempt | Result |', '|---|---|', ...rows].join('\n'),
    ...(more > 0 ? [`And ${more} more attempts.`] : []),
  ].join('\n\n');
};

const NEWLINE = String.fromCodePoint(0x0a);

/** A fence line at the top level: three or more backticks or tildes, and its info string. */
const OPENER = /^(`{3,}|~{3,})([\s\S]*)$/;
/** A closing fence: up to three spaces, the run, and only spaces and tabs after it. */
const CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A run of fence characters after an indent or a list or quote marker: inside a container. */
const CONTAINED = /^(?:[ \t]|[>*+-]|\d+[.)])[ \t>*+\-\d.)]*(?:`{3,}|~{3,})/;

/** The run and the info string of the fence `line` opens at the top level, or `undefined`. */
const fenceOpened = (line: string): { run: string; info: string } | undefined => {
  const [, run = '', info = ''] = OPENER.exec(line) ?? [];
  return run === '' || (run.startsWith('`') && info.includes('`')) ? undefined : { run, info };
};

/** Whether `line` closes the fence `run` opened: the same character, as long or longer. */
const fenceCloses = (run: string, line: string): boolean => {
  const closer = CLOSER.exec(line)?.[1] ?? '';
  return closer[0] === run[0] && closer.length >= run.length;
};

/**
 * Markdown that ends where it starts (ADR 0167): a fence it leaves open is closed, and a line that
 * would start an HTML block outside a fence starts with `&lt;` instead, since either would run to
 * the end of the body and swallow the engine's lines after it. Line ends are read as CommonMark
 * reads them (`\r\n` and `\r` too). A fence that starts inside a list, a quote or an indent ends
 * with its container, which this does not follow, so such a text is `undefined`: left out.
 */
const closedBlocks = (text: string): string | undefined => {
  let open: string | undefined;
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, NEWLINE).split(NEWLINE)) {
    if (open !== undefined) {
      if (fenceCloses(open, line)) open = undefined;
      lines.push(line);
      continue;
    }
    const opener = fenceOpened(line);
    if (opener !== undefined) {
      open = opener.run;
      lines.push(line);
      continue;
    }
    if (CONTAINED.test(line)) return undefined;
    lines.push(line.replace(/^( {0,3})</, '$1&lt;'));
  }
  return [...lines, ...(open === undefined ? [] : [open])].join(NEWLINE);
};

/** The line in place of a Mermaid block Foedrum cannot read (ADR 0180). */
const DIAGRAM_LEFT_OUT = '[left out: a diagram Foedrum could not check]';

/**
 * A label in quotes, which Mermaid accepts whatever it holds once its `"` is `#quot;`, and its `#`
 * is `#35;`: Mermaid reads `#479;` as an entity in a quoted label too.
 */
const quoted = (text: string): string =>
  `"${text.replaceAll('#', '#35;').replaceAll('"', '#quot;')}"`;
/**
 * An edge's or a title's label, trimmed, in quotes unless it is quoted already, or `undefined` when
 * it is empty: Mermaid reads no empty string, quoted or not.
 */
const label = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '""') return undefined;
  return /^"[^"]*"$/.test(trimmed) ? trimmed : quoted(trimmed);
};

/** A flowchart's node id, which may hold a `-` between its words but never before a link. */
const NODE_ID = String.raw`[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*`;
const FLOWCHART = /^(?:flowchart|graph)(?:[ \t]+(?:TB|TD|BT|RL|LR))?(?:[ \t]*;)?$/;
const DIRECTION = /^direction[ \t]+(?:TB|TD|BT|RL|LR)(?:[ \t]*;)?$/;
const STYLING = /^(?:classDef|class|style|linkStyle)(?=[ \t])[\p{L}\p{N}_ \t,:#%.()-]+;?$/u;
const SUBGRAPH = new RegExp(String.raw`^subgraph[ \t]+(?:"[^"]*"|${NODE_ID})$`, 'u');
const TITLED = new RegExp(String.raw`^subgraph[ \t]+${NODE_ID}[ \t]*\[[^\]]*\]$`, 'u');
const ID = new RegExp(NODE_ID, 'uy');
const CLASS = /:::[\p{L}\p{N}_-]+/uy;
const SPACE = /[ \t]*/y;
/** A link without text: `-->`, `---`, `--o`, `==>`, `-.->`, `<-->`, `~~~` and the longer ones. */
const LINK = /[<ox]?(?:-{2,}[>ox]|-{3,}|={2,}[>ox]|={3,}|-\.+-[>ox]?|~{3,})/y;
/** The start of a link with its text between the dashes: `-- x -->`, `== x ==>`, `-. x .->`. */
const TEXT_LINK = /([<ox]?)(--|==|-\.)[ \t]/y;
const TEXT_LINK_ENDS: Record<string, RegExp> = {
  '--': /-{2,}[>ox]|-{3,}/g,
  '==': /={2,}[>ox]|={3,}/g,
  // Only from the first dot of a run, so a run with no dash after it is read once.
  '-.': /(?<!\.)\.+-[>ox]?/g,
};
/** A node's shapes, the longer openers first, each with its closer. */
const SHAPES: readonly [open: string, close: string][] = [
  ['(((', ')))'],
  ['((', '))'],
  ['([', '])'],
  ['[[', ']]'],
  ['[(', ')]'],
  ['{{', '}}'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
  ['>', ']'],
];

/**
 * The shape of the node whose id ends at `at` in `line`, its label quoted, and where it ends; `none`
 * for a node without one, and `undefined` for a shape it cannot read. An unquoted label ends at the
 * first closer of its shape; `[/x/]` and `[\x\]`, and their mixes, are `[x]` with a slant inside.
 */
const shape = (line: string, at: number): { text: string; end: number } | 'none' | undefined => {
  const found = SHAPES.find(([open]) => line.startsWith(open, at));
  if (found === undefined) return 'none';
  const [open, close] = found;
  const from = at + open.length;
  const slanted = open === '[' && (line[from] === '/' || line[from] === '\\');
  const start = slanted ? from + 1 : from;
  if (line[start] === '"') {
    const quote = line.indexOf('"', start + 1);
    const closer = slanted ? line.slice(quote + 1, quote + 3) : close;
    if (
      quote <= start + 1 ||
      (slanted && !/^[/\\]\]$/.test(closer)) ||
      !line.startsWith(closer, quote + 1)
    ) {
      return undefined;
    }
    const end = quote + 1 + closer.length;
    return { text: line.slice(at, end), end };
  }
  const to = line.indexOf(close, from);
  if (to <= from) return undefined;
  const slant = line[to - 1] ?? '';
  if (slanted && to - 1 > from && (slant === '/' || slant === '\\')) {
    return { text: `[${line[from]}${quoted(line.slice(from + 1, to - 1))}${slant}]`, end: to + 1 };
  }
  return { text: `${open}${quoted(line.slice(from, to))}${close}`, end: to + close.length };
};

/**
 * A flowchart statement with its labels quoted, or `undefined`: nodes joined by links and `&`,
 * each node an id with an optional shape and `:::class`, and a closing `;`. Read once from the
 * left, each label up to its closer, so it is linear in the line.
 */
const statement = (line: string): string | undefined => {
  let out = '';
  let at = 0;
  const take = (text: string, end = at + text.length) => {
    out += text;
    at = end;
  };
  const sticky = (pattern: RegExp) => {
    pattern.lastIndex = at;
    return pattern.exec(line);
  };
  const space = () => take(sticky(SPACE)?.[0] ?? '');
  const node = (): boolean => {
    const id = sticky(ID)?.[0];
    if (id === undefined) return false;
    take(id);
    const shaped = shape(line, at);
    if (shaped === undefined) return false;
    if (shaped !== 'none') take(shaped.text, shaped.end);
    take(sticky(CLASS)?.[0] ?? '');
    return true;
  };
  const nodes = (): boolean => {
    if (!node()) return false;
    for (space(); line[at] === '&'; space()) {
      take('&');
      space();
      if (!node()) return false;
    }
    return true;
  };
  const link = (): boolean => {
    const arrow = sticky(LINK)?.[0];
    if (arrow !== undefined) {
      take(arrow);
      space();
      if (line[at] !== '|') return true;
      const close = line.indexOf('|', at + 1);
      if (close < 0) return false;
      const text = label(line.slice(at + 1, close));
      if (text === undefined) return false;
      take(`|${text}|`, close + 1);
      return true;
    }
    const opened = sticky(TEXT_LINK);
    const [, tail = '', kind = ''] = opened ?? [];
    const ends = TEXT_LINK_ENDS[kind];
    if (opened === null || ends === undefined) return false;
    ends.lastIndex = at + opened[0].length;
    const end = ends.exec(line);
    if (end === null) return false;
    const text = label(line.slice(at + opened[0].length, end.index));
    if (text === undefined) return false;
    // Written with its text between pipes, as `-->|"x"|`: the dotted link keeps its first dash.
    take(`${tail}${kind === '-.' ? '-' : ''}${end[0]}|${text}|`, end.index + end[0].length);
    return true;
  };
  space();
  if (!nodes()) return undefined;
  while (at < line.length && line[at] !== ';') {
    if (!link()) return undefined;
    space();
    if (!nodes()) return undefined;
  }
  const rest = line.slice(at);
  return /^(?:;[ \t]*)?$/.test(rest) ? out + rest : undefined;
};

/** A line of a flowchart with its labels quoted, or `undefined` for one it cannot read. */
const flowchartLine = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (DIRECTION.test(trimmed) || STYLING.test(trimmed) || SUBGRAPH.test(trimmed)) return line;
  if (!TITLED.test(trimmed)) return statement(line);
  const open = line.indexOf('[');
  const close = line.indexOf(']', open);
  const title = label(line.slice(open + 1, close));
  return title === undefined
    ? undefined
    : `${line.slice(0, open)}[${title}]${line.slice(close + 1)}`;
};

const ACTOR = String.raw`[\p{L}\p{N}_]+`;
const SEQUENCE = /^sequenceDiagram$/;
/** A message or a note, up to the `:` its text follows. */
const MESSAGE = new RegExp(
  String.raw`^(?:${ACTOR}[ \t]*(?:<<)?--?(?:>>|>|x|\))[+-]?[ \t]*${ACTOR}|[Nn]ote[ \t]+(?:over|left of|right of)[ \t]+${ACTOR}(?:[ \t]*,[ \t]*${ACTOR})?)[ \t]*:`,
  'u',
);
/** A block's keyword, or a participant up to its alias, which the text follows. */
const TEXT_AFTER = new RegExp(
  String.raw`^(?:(?:loop|alt|else|opt|par|and|critical|option|break)(?![\p{L}\p{N}_])|(?:participant|actor)[ \t]+${ACTOR}[ \t]+as[ \t])`,
  'u',
);
const BARE = new RegExp(
  String.raw`^(?:(?:participant|actor|activate|deactivate)[ \t]+${ACTOR}|autonumber|end)$`,
  'u',
);

/** A line of a sequence diagram, its text's `;` and `#` as entities, or `undefined`. */
const sequenceLine = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (BARE.test(trimmed)) return line;
  const start = line.length - line.trimStart().length;
  const head = MESSAGE.exec(trimmed)?.[0] ?? TEXT_AFTER.exec(trimmed)?.[0];
  if (head === undefined) return undefined;
  const at = start + head.length;
  return `${line.slice(0, at)}${line.slice(at).replace(/[;#]/g, (char) => (char === ';' ? '#59;' : '#35;'))}`;
};

/** A Mermaid block's lines with their labels quoted, or `undefined` for a block it cannot read. */
const quotedDiagram = (lines: readonly string[]): string[] | undefined => {
  let read: ((line: string) => string | undefined) | undefined;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // A blank line or a comment, but not a `%%{` directive.
    if (trimmed === '' || (trimmed.startsWith('%%') && !trimmed.startsWith('%%{'))) {
      out.push(line);
      continue;
    }
    if (read === undefined) {
      if (FLOWCHART.test(trimmed)) read = flowchartLine;
      else if (SEQUENCE.test(trimmed)) read = sequenceLine;
      else return undefined;
      out.push(line);
      continue;
    }
    const written = read(line);
    if (written === undefined) return undefined;
    out.push(written);
  }
  return read === undefined ? undefined : out;
};

/**
 * `text`, whose fences are paired (`closedBlocks`), with every node and edge label of each Mermaid
 * block quoted, and a block of a kind or with a line Foedrum cannot read left out whole, one line
 * in its place (ADR 0180). The other fences and the text outside them stay as they are.
 */
export const quotedDiagrams = (text: string): string => {
  const lines = text.split(NEWLINE);
  const out: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    const opener = fenceOpened(line);
    if (opener === undefined) {
      out.push(line);
      continue;
    }
    let end = at + 1;
    while (end < lines.length && !fenceCloses(opener.run, lines[end] ?? '')) end += 1;
    const body = lines.slice(at + 1, end);
    const closer = lines.slice(end, end + 1);
    const diagram = /^[ \t]*mermaid(?:[ \t]|$)/i.test(opener.info) ? quotedDiagram(body) : body;
    out.push(...(diagram === undefined ? [DIAGRAM_LEFT_OUT] : [line, ...diagram, ...closer]));
    at = end;
  }
  return out.join(NEWLINE);
};

/** The longest how it works and See it, once made safe: `unlinked` and the escapes make them grow. */
const MAX_SHOWN_HOW = 12_000;
const MAX_SHOWN_SEE = 1_200;

/** The model's sections, without secrets and with nothing GitHub would act on (ADR 0167). */
const howItWorks = (stepId: string, sections: PullRequestSections, isCommit: IsCommit): string => {
  const shown = (text: string) => unlinked(withoutSecrets(text, stepId, isCommit));
  // A section that grew past its room is left out whole: cutting it could break its Markdown.
  const within = (text: string, max: number) =>
    text.length <= max
      ? text
      : `[left out: a text of step ${stepId} that is too long once made safe for GitHub]`;
  // A fence it cannot pair as GitHub would is left out whole too, failing closed; once paired, a
  // Mermaid block has its labels quoted, or is left out (ADR 0180).
  const checked = (text: string) => {
    const closed = closedBlocks(text);
    return closed === undefined
      ? `[left out: a text of step ${stepId} with a fence Foedrum cannot check outside its top level]`
      : quotedDiagrams(closed);
  };
  // Made one line, escaped and cut before `unlinked`, which then pairs the spans GitHub reads, so
  // no cut leaves a kept `@` in a span it opened (ADR 0184). `unlinked` can make it longer
  // (`&amp;`), so it is cut shorter until it fits: 20 rows of grown cells would pass GitHub's limit.
  const cell = (text: string) => {
    const flat = withoutSecrets(text, stepId, isCommit)
      .replace(/\s+/g, ' ')
      .replaceAll('\\', '\\\\')
      .replaceAll('|', '\\|');
    for (let max = MAX_CELL; ; ) {
      const safe = unlinked(flat.slice(0, max));
      if (safe.length <= MAX_CELL) return safe;
      // Shorter by the share it grew, and by one at least, so it ends at the empty text.
      max = Math.min(max - 1, Math.floor((max * MAX_CELL) / safe.length));
    }
  };
  const table = sections.beforeAfter.map(
    (row) => `| ${cell(row.case)} | ${cell(row.before)} | ${cell(row.after)} |`,
  );
  const { howItWorks: how, seeIt } = sections;
  return [
    '## How it works',
    ...(how === undefined ? [] : [within(checked(shown(how).trim()), MAX_SHOWN_HOW)]),
    ...(table.length === 0 ? [] : [['| | Before | After |', '|---|---|---|', ...table].join('\n')]),
    ...(seeIt === undefined
      ? []
      : // Made one line before `unlinked`, which then pairs the spans of the line GitHub reads.
        [
          `**See it:** ${within(unlinked(withoutSecrets(seeIt, stepId, isCommit).replace(/\s+/g, ' ')), MAX_SHOWN_SEE)}`,
        ]),
  ].join('\n\n');
};

/** The line of a body without how it works, which then opens as a draft. */
const NO_HOW = 'No How it works: the Cellarman wrote none.';

/** Why the pull request is a draft or ready, in one line. */
const draftLine = (reports: readonly StepReport[], written: boolean): string => {
  if (!opensAsDraft(reports)) {
    return written
      ? 'Ready for review: every Taster approved.'
      : 'A person reviews this before it is marked ready: every Taster approved, but it has no How it works.';
  }
  const asking = reports.filter(({ tasting }) => tasting?.verdict === 'changes');
  return asking.length === 0
    ? 'A person reviews this before it is marked ready: no step tasted the change.'
    : `A person reviews this before it is marked ready: a Taster asks for changes (${asking.map(({ stepId }) => stepId).join(', ')}); its findings are in the reports below.`;
};

/**
 * The pull request's title and body, in one layout for every repository (ADR 0167): how it works,
 * before and after and See it from the sections a `pullRequest` brewer wrote, how it was brewed,
 * the reports folded, and `Closes`. The sections are model text outside a fence, so mentions,
 * closing keywords and numeric character references are taken out of them, outside a code span
 * (`unlinked`, ADR 0184). The
 * reports are quoted in a fenced block, where GitHub links no issue, mentions nobody and reads no
 * closing keyword. A text that looks like a secret is left out (ADR 0088).
 */
export const pullRequestText = ({
  title,
  closes,
  reports,
  isCommit = () => false,
  recipe,
  attempts = [],
  key,
}: PullRequestTextInput): PullRequestText => {
  const order = `${closes.repo}#${closes.issue}`;
  const oneLine = title.replace(/\s+/g, ' ').trim();
  const written = reports.findLast(({ sections }) => sections !== undefined);
  const head = [
    ...(written?.sections === undefined
      ? []
      : [howItWorks(written.stepId, written.sections, isCommit)]),
    '## How this was brewed',
    `Brewed by Foedrum from ${order}${recipe === undefined ? '' : ` with the recipe ${recipe}`}.`,
    // Without how it works, a person reads the change first, whatever the Tasters say.
    ...(written?.sections?.howItWorks === undefined ? [NO_HOW] : []),
    draftLine(reports, written?.sections?.howItWorks !== undefined),
    ...(attempts.length === 0 ? [] : [brewTable(attempts, isCommit)]),
  ].join('\n\n');
  const closing = `Closes ${order}`;
  // The marker, when there is one, is as long whatever the text above it (ADR 0227).
  const marking = key === undefined ? 0 : bodyMarker(key, '').length + 2;
  // The reports get what the sections leave of GitHub's limit, at most MAX_REPORTS.
  const room = Math.max(
    0,
    Math.min(MAX_REPORTS, MAX_BODY - head.length - closing.length - marking - FRAME),
  );
  // Only what can be shown is read (ADR 0088): reports of 1 MiB would cost a second at every apply.
  let unread = room + SCAN_PAST;
  let cut = false;
  const shown = (text: string, stepId: string): string => {
    const read = text.slice(0, Math.max(0, unread));
    unread -= read.length + 1;
    if (read.length < text.length) cut = true;
    return withoutSecrets(read, stepId, isCommit);
  };
  const flat = (text: string, stepId: string) => shown(text, stepId).replace(/\s+/g, ' ');
  const lines = reports.flatMap(
    ({ stepId, summary, assumptions, tasting, fining, gauge, toFile }) => [
      `${stepId}: ${shown(summary, stepId)}`,
      ...assumptions.map((assumption) => `  assumed: ${flat(assumption, stepId)}`),
      ...(gauge?.tests ?? []).map((name) => `  test: ${flat(name, stepId)}`),
      ...(gauge?.regressionTests ?? []).map((name) => `  regression test: ${flat(name, stepId)}`),
      // What a Finer changed, or why nothing (ADR 0166).
      ...(fining?.changes ?? []).map(
        (change) =>
          `  simplified: ${flat(changeText(change), stepId)}: ${flat(change.why, stepId)}`,
      ),
      ...(fining?.unchanged === undefined
        ? []
        : [`  unchanged: ${flat(fining.unchanged, stepId)}`]),
      // The findings it left as there before the change, for the reviewer to file (ADR 0191).
      ...(toFile ?? []).map(
        (found) => `  to file: ${flat(placeOf(found), stepId)}: ${flat(found.why, stepId)}`,
      ),
      // A Taster's findings are listed, never acted on, unless its step is blocking (ADR 0161).
      ...(tasting === undefined
        ? []
        : [
            `  verdict: ${tasting.verdict}`,
            ...tasting.findings.map(
              (finding) =>
                `  finding: ${flat(findingText(finding), stepId)}: ${flat(finding.why, stepId)}`,
            ),
            // What its review leaves, in its words (ADR 0214).
            ...(tasting.riskLeft ?? []).map((risk) => `  risk left: ${flat(risk, stepId)}`),
          ]),
    ],
  );
  // The fence is longer than any run of backticks in the reports, so a run is cut to 16: model
  // output could otherwise make the fence, which comes twice, as long as the reports.
  let quoted = lines.join('\n').replace(/`{17,}/g, '`'.repeat(16));
  if (cut || quoted.length > room) quoted = `${quoted.slice(0, room)}\n${CUT}`;
  const longest = Math.max(0, ...[...quoted.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const reported =
    lines.length === 0
      ? []
      : [
          '<details><summary>What each step reported</summary>',
          `${fence}text\n${quoted}\n${fence}`,
          '</details>',
        ];
  const body = [head, ...reported, closing].join('\n\n');
  return {
    title: oneLine === '' ? order : oneLine.slice(0, MAX_TITLE),
    body: key === undefined ? body : `${body}\n\n${bodyMarker(key, body)}`,
    draft: opensAsDraft(reports) || written?.sections?.howItWorks === undefined,
  };
};
