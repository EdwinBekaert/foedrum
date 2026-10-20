// The openPullRequest action (ADR 0071), the pure core: the keys of its two effects, the bottle
// branch it pushes, the pull request the ledger recorded, and the pull request's text from the
// order and the brewers' out docs.

import type { IsCommit } from '../formats/secrets.ts';
import { OutDocFrontmatter } from '../schemas/out-doc.ts';
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
}

/** The reports of `batch`'s steps, in the order they were first scheduled. */
export const stepReports = (batch: Batch): StepReport[] =>
  [...batch.steps.values()].flatMap((step) => {
    const latest = [...step.attempts.values()]
      .filter((attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded')
      .at(-1);
    if (latest?.phase !== 'finished' || latest.outcome.kind !== 'succeeded') return [];
    // A check's success has no out doc.
    const doc = OutDocFrontmatter.safeParse(latest.outcome.output);
    if (!doc.success) return [];
    return [{ stepId: step.id, summary: doc.data.summary, assumptions: doc.data.assumptions }];
  });

export interface PullRequestTextInput {
  /** The title of the order's issue: untrusted. */
  title: string;
  /** The order's issue, which the pull request closes. */
  closes: { repo: string; issue: number };
  /** Model output: untrusted. */
  reports: readonly StepReport[];
  /** Whether a 40-character hexadecimal word is a commit, not a key; none is when absent. */
  isCommit?: IsCommit;
}

export interface PullRequestText {
  title: string;
  body: string;
}

/** GitHub's longest title of a pull request. */
const MAX_TITLE = 256;
/** GitHub's longest body, less room for the lines around the reports. */
const MAX_REPORTS = 60_000;
const CUT = '(cut short)';
/** How far past the cut the reports are read for secrets: room for a match that starts before it. */
const SCAN_PAST = 1_000;

/**
 * The pull request's title and body. The reports are quoted in a fenced block, where GitHub links
 * no issue, mentions nobody and reads no closing keyword: a model could write `Fixes #3`. A report
 * text that looks like a secret is left out (ADR 0088).
 */
export const pullRequestText = ({
  title,
  closes,
  reports,
  isCommit = () => false,
}: PullRequestTextInput): PullRequestText => {
  const order = `${closes.repo}#${closes.issue}`;
  const oneLine = title.replace(/\s+/g, ' ').trim();
  // Only what can be shown is read (ADR 0088): reports of 1 MiB would cost a second at every apply.
  let unread = MAX_REPORTS + SCAN_PAST;
  let cut = false;
  const shown = (text: string, stepId: string): string => {
    const read = text.slice(0, Math.max(0, unread));
    unread -= read.length + 1;
    if (read.length < text.length) cut = true;
    return withoutSecrets(read, stepId, isCommit);
  };
  const lines = reports.flatMap(({ stepId, summary, assumptions }) => [
    `${stepId}: ${shown(summary, stepId)}`,
    ...assumptions.map(
      (assumption) => `  assumed: ${shown(assumption, stepId).replace(/\s+/g, ' ')}`,
    ),
  ]);
  // The fence is longer than any run of backticks in the reports, so a run is cut to 16: model
  // output could otherwise make the fence, which comes twice, as long as the reports.
  let quoted = lines.join('\n').replace(/`{17,}/g, '`'.repeat(16));
  if (cut || quoted.length > MAX_REPORTS) quoted = `${quoted.slice(0, MAX_REPORTS)}\n${CUT}`;
  const longest = Math.max(0, ...[...quoted.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const reported =
    lines.length === 0
      ? `Brewed by Foedrum from ${order}.`
      : `Brewed by Foedrum from ${order}. What each step reported:\n\n${fence}text\n${quoted}\n${fence}`;
  return {
    title: oneLine === '' ? order : oneLine.slice(0, MAX_TITLE),
    body: `${reported}\n\nCloses ${order}`,
  };
};
