// The openPullRequest action (ADR 0071), the pure core: the keys of its two effects, the bottle
// branch it pushes, the pull request the ledger recorded, and the pull request's text from the
// order and the brewers' out docs.

import type { IsCommit } from '../formats/secrets.ts';
import {
  type FiningChange,
  FiningOutDoc,
  type FiningReport,
  finingOf,
  GaugeOutDoc,
  type GaugeReport,
  gaugeOf,
  OutDocFrontmatter,
  PullRequestOutDoc,
  type PullRequestSections,
  pullRequestSectionsOf,
  type TastingFinding,
  TastingOutDoc,
  type TastingReport,
  tastingOf,
} from '../schemas/out-doc.ts';
import { type BatchEffectKey, PushResult } from '../schemas/store.ts';
import { repoFolder } from '../workspace/attempt-worktrees.ts';
import { effectKey } from './effect-key.ts';
import type { Batch, State } from './fold.ts';
import { withoutSecrets } from './out-doc-text.ts';

/** The effect that pushes the batch's task tree to its bottle branch, once per batch. */
export const pushKey = (batchId: string): BatchEffectKey => ({ batchId, effect: 'push' });

/** The effect that opens the batch's pull request, once per batch. */
export const pullRequestKey = (batchId: string): BatchEffectKey => ({
  batchId,
  effect: 'pull_request',
});

/** The local name of the batch's bottle branch in `repo`: `foedrum/<batch>/<owner>.<name>`. */
export const bottleBranch = (batchId: string, repo: string): string =>
  `foedrum/${batchId}/${repoFolder(repo)}`;

/** The pull request the ledger recorded for `batchId`, by its URL, or `undefined`. */
export const openedPullRequest = (state: State, batchId: string): string | undefined => {
  const result = state.effects.get(effectKey.encode(pullRequestKey(batchId)));
  return typeof result === 'string' ? result : undefined;
};

/**
 * The commits the state records for `batchId`, which a 40-character hexadecimal word may name
 * without being a key (ADR 0088): where its attempts' worktrees started, its rewinds' commits, and
 * the commit its push recorded or the commits it refused (ADR 0079). Read from the folded state,
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
  const pushed = PushResult.safeParse(state.effects.get(effectKey.encode(pushKey(batchId))));
  if (pushed.success) {
    commits.add(pushed.data.commit);
    for (const { commit } of pushed.data.refused ?? []) commits.add(commit);
  }
  return (word) => commits.has(word);
};

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
    return [
      {
        stepId: step.id,
        summary,
        assumptions,
        ...(tasting === undefined ? {} : { tasting }),
        ...(sections === undefined ? {} : { sections }),
        ...(fining === undefined ? {} : { fining }),
        ...(gauge === undefined ? {} : { gauge }),
      },
    ];
  });

/** Where a finding is, how bad, and whether it was there before the change, on one line. */
export const findingText = ({ file, line, severity, introduced }: TastingFinding): string => {
  const where = file === undefined ? '' : ` in ${file}${line === undefined ? '' : `:${line}`}`;
  return `${severity}${where}${introduced ? '' : ', there before the change'}`;
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
      const run = CLOSER.exec(line)?.[1] ?? '';
      if (run[0] === open[0] && run.length >= open.length) open = undefined;
      lines.push(line);
      continue;
    }
    const opener = OPENER.exec(line);
    if (opener !== null && !(opener[1]?.startsWith('`') && opener[2]?.includes('`'))) {
      open = opener[1];
      lines.push(line);
      continue;
    }
    if (CONTAINED.test(line)) return undefined;
    lines.push(line.replace(/^( {0,3})</, '$1&lt;'));
  }
  return [...lines, ...(open === undefined ? [] : [open])].join(NEWLINE);
};

/**
 * `text`, whose fences are paired, with every label of each Mermaid block quoted, or the block left
 * out when Foedrum cannot read it (ADR 0180).
 */
export const quotedDiagrams = (_text: string): string => {
  throw new Error('not implemented');
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
  // A fence it cannot pair as GitHub would is left out whole too, failing closed.
  const checked = (text: string) =>
    closedBlocks(text) ??
    `[left out: a text of step ${stepId} with a fence Foedrum cannot check outside its top level]`;
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
  // The reports get what the sections leave of GitHub's limit, at most MAX_REPORTS.
  const room = Math.max(0, Math.min(MAX_REPORTS, MAX_BODY - head.length - closing.length - FRAME));
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
  const lines = reports.flatMap(({ stepId, summary, assumptions, tasting, fining, gauge }) => [
    `${stepId}: ${shown(summary, stepId)}`,
    ...assumptions.map((assumption) => `  assumed: ${flat(assumption, stepId)}`),
    ...(gauge?.tests ?? []).map((name) => `  test: ${flat(name, stepId)}`),
    ...(gauge?.regressionTests ?? []).map((name) => `  regression test: ${flat(name, stepId)}`),
    // What a Finer changed, or why nothing (ADR 0166).
    ...(fining?.changes ?? []).map(
      (change) => `  simplified: ${flat(changeText(change), stepId)}: ${flat(change.why, stepId)}`,
    ),
    ...(fining?.unchanged === undefined ? [] : [`  unchanged: ${flat(fining.unchanged, stepId)}`]),
    // A Taster's findings are listed, never acted on, unless its step is blocking (ADR 0161).
    ...(tasting === undefined
      ? []
      : [
          `  verdict: ${tasting.verdict}`,
          ...tasting.findings.map(
            (finding) =>
              `  finding: ${flat(findingText(finding), stepId)}: ${flat(finding.why, stepId)}`,
          ),
        ]),
  ]);
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
  return {
    title: oneLine === '' ? order : oneLine.slice(0, MAX_TITLE),
    body: [head, ...reported, closing].join('\n\n'),
    draft: opensAsDraft(reports) || written?.sections?.howItWorks === undefined,
  };
};
