// A pre-existing finding as a Brewery issue once its batch's pull requests merged (ADR 0356): one
// issue per finding a Taster raised and the step its findings route went back to left as there
// before the change (ADR 0191), each through the ledger and found by its key before it is applied
// (ADR 0033), with the label that marks it and no recipe.

import { pullRequestOf } from '../schemas/events.ts';
import { type Disposition, lensFirst, placeOf, type TastingFinding } from '../schemas/out-doc.ts';
import { StatusRevision } from '../schemas/status-comment.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import { effectMarker } from './claim-effects.ts';
import { breweryIssueOf } from './claim-orders.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey, numberedEffects } from './effect-key.ts';
import type { Batch, State } from './fold.ts';
import { lensRounds, roundFindings, withDispositions } from './lens-rounds.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { OpenedIssue, openedIssue } from './plan-applied.ts';
import { knownCommits } from './pull-request.ts';
import { code, longest, plainWithin } from './status-comment.ts';
import type { SubIssues } from './sub-issues.ts';

/** The label of every issue a pre-existing finding opens (ADR 0356). */
export const PRE_EXISTING = 'foedrum:pre-existing';

/** The longest a Taster's or a brewer's words are in an issue's body. */
const longestWhy = 2_000;

/** Where the issues open: the Brewery's issues, and its labels. */
export interface PreExistingHost extends Pick<SubIssues, 'findIssue' | 'openIssue'> {
  /** Creates the label `label` in `repo`; one there already counts as made. */
  createLabel(repo: string, label: string, signal?: AbortSignal): Promise<void>;
}

export interface PreExistingIssueEffectsOptions {
  host: PreExistingHost;
  /** The Brewery repository, `owner/name`. */
  brewery: string;
}

/** An issue the ledger has for a pre-existing finding of a batch, and the finding. */
export interface FiledIssue {
  number: number;
  stepId: string;
  finding: TastingFinding;
}

/** A pre-existing finding: the Taster's step and round, the finding, and what was said of it. */
interface PreExisting {
  key: BatchEffectKey;
  stepId: string;
  attempt: number;
  finding: TastingFinding;
  disposition: Extract<Disposition, { disposition: 'pre-existing' }>;
  /** The step that left it as pre-existing. */
  by: string;
}

/** Whether every pull request of `batch` merged. */
const merged = (batch: Batch): boolean => {
  const { lane } = batch;
  if (lane.kind !== 'on_tap' || lane.pullRequests.length === 0) return false;
  return lane.pullRequests.every((url) => batch.pullRequestEnds?.[url] === 'merged');
};

/**
 * Whether a revision of the status comment of `batchId` in the ledger showed its end (ADR 0345):
 * one rendered after it ended, or before that record, which said nothing of it. Unlike
 * `endShown`, which a mark and its recovery clear, the ledger keeps it.
 */
const endShownIn = (state: State, batchId: string): boolean =>
  numberedEffects(
    state,
    (n) => ({ batchId, effect: `status.${n}` }),
    StatusRevision,
    "a status comment's revision",
  ).some((revision) => revision.open !== true);

/**
 * The findings of `batch` the step a findings route went back to left as pre-existing, each paired
 * with its disposition as the merge brief pairs them (ADR 0191), keyed by its step, its round and
 * its place among the round's findings: none until every pull request of it merged.
 */
const preExistingOf = (batch: Batch): PreExisting[] => {
  if (!merged(batch)) return [];
  return [...batch.steps.keys()].flatMap((stepId) =>
    lensRounds(batch, stepId).flatMap(({ attempt, ran, dispositions, by = stepId }) =>
      withDispositions(roundFindings(ran), dispositions).flatMap(
        ({ finding, disposition }, at): PreExisting[] =>
          disposition?.disposition === 'pre-existing'
            ? [
                {
                  key: { batchId: batch.id, effect: `pre-existing.${stepId}.${attempt}.${at + 1}` },
                  stepId,
                  attempt,
                  finding,
                  disposition,
                  by,
                },
              ]
            : [],
      ),
    ),
  );
};

/** The issues the ledger has for the pre-existing findings of `batchId`, in the order they are due. */
export const filedIssues = (state: State, batchId: string): FiledIssue[] => {
  const batch = state.batches.get(batchId);
  return (batch === undefined ? [] : preExistingOf(batch)).flatMap(({ key, stepId, finding }) => {
    const opened = openedIssue(state, key);
    return opened === undefined ? [] : [{ number: opened.number, stepId, finding }];
  });
};

/**
 * The issue of `found`: its title, plain text as GitHub shows a title, and its body, every model
 * text in both with what looks like a secret left out, and in the body escaped as the status
 * comment's.
 */
const issueOf = (state: State, batch: Batch, found: PreExisting) => {
  const isCommit = knownCommits(state, batch.id);
  const told = (text: string, stepId: string, most: number): string =>
    plainWithin(withoutSecrets(text, stepId, isCommit), most);
  const { stepId, attempt, finding, disposition, by } = found;
  const place = withoutSecrets(placeOf(finding), stepId, isCommit).replace(/\s+/g, ' ');
  // Cut between characters, never inside one.
  const title = [...`Pre-existing: ${lensFirst(finding)}${finding.severity} in ${place}`]
    .slice(0, longest)
    .join('');
  const where = told(placeOf(finding), stepId, longest);
  const order = breweryIssueOf(state, batch);
  const names = batch.lane.kind === 'on_tap' ? batch.lane.pullRequests : [];
  const pullRequests = names.map((url) => {
    const { repo, number } = pullRequestOf(url);
    return `${repo}#${number}`;
  });
  const body = [
    `A finding there before the change, from batch ${code(batch.id)}${order === undefined ? '' : ` of #${order}`}, which merged as ${pullRequests.join(', ')} (ADR 0356).`,
    '',
    `- Found by ${code(stepId)} in its attempt ${attempt}: ${told(`${lensFirst(finding)}${finding.severity}`, stepId, longest)} in ${where}`,
    `- The Taster: ${told(finding.why, stepId, longestWhy)}`,
    `- Left as pre-existing: ${told(disposition.why, by, longestWhy)}`,
    '',
    'It has no recipe label, so the intake does not order it.',
  ].join('\n');
  return { title, body };
};

/**
 * The issue of each pre-existing finding of a batch whose pull requests all merged, for the driver:
 * the label made first, then the issue, in the Brewery only. One found by its key is not opened
 * again.
 */
export const preExistingIssueEffects = (options: PreExistingIssueEffectsOptions): DriverEffects => {
  const { host, brewery } = options;
  // What each key `due` gave opens; the driver asks `due` before it applies a key.
  const issues = new Map<string, { title: string; body: string }>();
  return {
    // A batch whose end its status comment showed, before this record too, opens none (ADR 0356).
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      if (batch === undefined || endShownIn(state, batchId)) return [];
      return preExistingOf(batch).map((found) => {
        issues.set(effectKey.encode(found.key), issueOf(state, batch, found));
        return found.key;
      });
    },
    target: {
      find: async (key, signal) => {
        const found = await host.findIssue(effectMarker(key), signal);
        return found === undefined ? undefined : { result: OpenedIssue.parse(found) };
      },
      apply: async (key, signal) => {
        const issue = issues.get(key);
        if (issue === undefined) throw new Error(`No pre-existing finding's issue ${key} is due`);
        await host.createLabel(brewery, PRE_EXISTING, signal);
        const body = `${issue.body}\n\n${effectMarker(key)}`;
        return OpenedIssue.parse(await host.openIssue(issue.title, body, [PRE_EXISTING], signal));
      },
    },
  };
};
