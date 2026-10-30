// The claim marks and the release of a claimed target-repository issue as the driver's effects
// (ADR 0043, #103). What is due comes from the recorded events alone: the batch's lane, and the end
// of each of its pull requests that the intake recorded (`pull_request.ended`). Nothing here asks
// the code host whether a pull request merged. Each effect is found by its key before it is
// applied (ADR 0033), and the driver holds it to its deadline (#130). The Brewery issue that is the
// claimed issue's order is opened, and closed with a merge, the same way (ADR 0144).

import { claimOrderOf } from './claim-orders.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import {
  type Claimant,
  type ClaimEffect,
  type ClaimHost,
  claimEffectsDue,
  releaseClaim,
  same,
} from './issue-claims.ts';

/**
 * The code host side of an issue's marks, as the Brewery's own identity sees and makes them. Every
 * call stops when `signal` aborts.
 */
export interface IssueMarks {
  /** The logins the issue is assigned to. */
  assignees(repo: string, issue: number, signal?: AbortSignal): Promise<readonly string[]>;
  assign(repo: string, issue: number, login: string, signal?: AbortSignal): Promise<void>;
  /** The names of the issue's labels. */
  labels(repo: string, issue: number, signal?: AbortSignal): Promise<readonly string[]>;
  addLabel(repo: string, issue: number, label: string, signal?: AbortSignal): Promise<void>;
  removeLabel(repo: string, issue: number, label: string, signal?: AbortSignal): Promise<void>;
  /**
   * The id of a comment on the issue that carries `marker` and that the Brewery's own identity
   * made, or undefined: a comment by anyone else never counts, since keys are predictable.
   */
  findComment(
    repo: string,
    issue: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<number | undefined>;
  /** Comments on the issue; the new comment's id. */
  comment(repo: string, issue: number, body: string, signal?: AbortSignal): Promise<number>;
  /** The issue's title. */
  title(repo: string, issue: number, signal?: AbortSignal): Promise<string>;
  /**
   * Whether the issue is open or closed, or gone: a person deleted it (ADR 0144). An issue that
   * cannot be read for any other reason fails.
   */
  issueState(
    repo: string,
    issue: number,
    signal?: AbortSignal,
  ): Promise<'open' | 'closed' | 'gone'>;
  /** Closes or reopens the issue. */
  setIssueState(
    repo: string,
    issue: number,
    state: 'open' | 'closed',
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * The number of an issue of `repo` that carries `marker` and that the Brewery's own identity
   * opened, or undefined (ADR 0144).
   */
  findIssue(repo: string, marker: string, signal?: AbortSignal): Promise<number | undefined>;
  /** Opens an issue in `repo`; its number. */
  openIssue(repo: string, title: string, body: string, signal?: AbortSignal): Promise<number>;
}

/** The hidden marker that carries an effect's key in a comment, so `findComment` finds it. */
export const effectMarker = (key: string): string => `<!-- foedrum:${key} -->`;

export interface ClaimEffectsOptions {
  claimant: Claimant;
  marks: IssueMarks;
  claims: ClaimHost;
  /** How long one effect may take; the driver's default when left out (`DriverEffects`). */
  deadlineMs?: number;
}

// The id the code host answered for a comment or an issue, which the ledger keeps for good.
const positive =
  (what: string) =>
  (id: number): number => {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error(`The code host answered ${what} that is no positive integer: ${id}`);
    }
    return id;
  };
/** The id the code host answered for a comment, checked: a positive integer, or it throws. */
export const commentId = positive('a comment id');
const issueNumber = positive('an issue number');

/** Where `effect` lands: found by being there, by its key in our own comment, or by a gone ref. */
export const claimEffectTarget = (
  effect: ClaimEffect,
  marks: IssueMarks,
  claims: ClaimHost,
): EffectTarget => {
  const { repo, issue } = effect;
  const labelled = async (label: string, signal?: AbortSignal): Promise<boolean> =>
    (await marks.labels(repo, issue, signal)).some((name) => same(name, label));
  switch (effect.kind) {
    case 'assign':
      return {
        find: async (_key, signal) => {
          const assignees = await marks.assignees(repo, issue, signal);
          return assignees.some((login) => same(login, effect.login))
            ? { result: effect.login }
            : undefined;
        },
        apply: async (_key, signal) => {
          await marks.assign(repo, issue, effect.login, signal);
          return effect.login;
        },
      };
    case 'add_label':
      return {
        find: async (_key, signal) =>
          (await labelled(effect.label, signal)) ? { result: null } : undefined,
        apply: async (_key, signal) => {
          await marks.addLabel(repo, issue, effect.label, signal);
          return null;
        },
      };
    case 'remove_label':
      return {
        find: async (_key, signal) =>
          (await labelled(effect.label, signal)) ? undefined : { result: null },
        apply: async (_key, signal) => {
          await marks.removeLabel(repo, issue, effect.label, signal);
          return null;
        },
      };
    case 'comment':
      return {
        find: async (key, signal) => {
          const id = await marks.findComment(repo, issue, effectMarker(key), signal);
          return id === undefined ? undefined : { result: commentId(id) };
        },
        apply: async (key, signal) =>
          commentId(
            await marks.comment(repo, issue, `${effect.body}\n\n${effectMarker(key)}`, signal),
          ),
      };
    case 'release_ref':
      return {
        // Gone: released by a run before, or by hand; nothing is left to release.
        find: async (_key, signal) =>
          (await claims.read(repo, issue, signal)) === undefined ? { result: 'gone' } : undefined,
        apply: (_key, signal) =>
          releaseClaim(claims, { repo, issue, brewery: effect.brewery, signal }),
      };
    case 'open_order':
      return {
        // Found by its key in an issue of the Brewery its own identity opened.
        find: async (key, signal) => {
          const number = await marks.findIssue(effect.brewery, effectMarker(key), signal);
          return number === undefined ? undefined : { result: issueNumber(number) };
        },
        // Only the title is copied: the target issue's text stays where it is (ADR 0144).
        apply: async (key, signal) => {
          const title = await marks.title(repo, issue, signal);
          const body = `${effect.body}\n\n${effectMarker(key)}`;
          return issueNumber(await marks.openIssue(effect.brewery, title, body, signal));
        },
      };
    case 'issue_state':
      return {
        // Gone: a person deleted the Brewery issue; nothing is left to close or reopen, and a
        // failing effect would hold off the rest of the release (ADR 0144).
        find: async (_key, signal) => {
          const state = await marks.issueState(repo, issue, signal);
          if (state === 'gone') return { result: 'gone' };
          return state === effect.state ? { result: null } : undefined;
        },
        apply: async (_key, signal) => {
          await marks.setIssueState(repo, issue, effect.state, signal);
          return null;
        },
      };
    default:
      return effect satisfies never;
  }
};

/**
 * The claim effects of every batch of a claimed target issue, for the driver: the marks while the
 * batch is live or a pull request of it has no recorded end, the release once it is cancelled or
 * every pull request it opened has a recorded end (`claimEffectsDue`).
 */
export const claimEffects = (options: ClaimEffectsOptions): DriverEffects => {
  const { claimant, marks, claims, deadlineMs } = options;
  // The effect behind each key `due` gave; the driver asks `due` before it applies a key.
  const effects = new Map<string, ClaimEffect>();
  const targetOf = (key: string): EffectTarget => {
    const effect = effects.get(key);
    if (effect === undefined) throw new Error(`No claim effect ${key} is due`);
    return claimEffectTarget(effect, marks, claims);
  };
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      if (batch?.repo === undefined) return [];
      const ends = batch.pullRequestEnds ?? {};
      const order = claimOrderOf(state, batchId);
      const due = claimEffectsDue(
        { batchId, repo: batch.repo, issue: batch.issue, lane: batch.lane, order },
        claimant,
        (url) => ends[url] ?? 'open',
      );
      for (const { key, effect } of due) effects.set(effectKey.encode(key), effect);
      return due.map(({ key }) => key);
    },
    target: {
      find: (key, signal) => targetOf(key).find(key, signal),
      apply: (key, signal) => targetOf(key).apply(key, signal),
    },
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
};
