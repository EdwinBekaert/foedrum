// A fake GitHub for claim tests: one target repository's claim refs and issue marks, shared by
// every Brewery that uses it, with no network (ADR 0021). Creating a ref is atomic, as on GitHub:
// it yields once, so that concurrent claims interleave, and then checks and sets in one step.

import type { EffectTarget } from '../../src/engine/effects.ts';
import { type ClaimEffect, type ClaimHost, releaseClaim } from '../../src/engine/issue-claims.ts';

export interface FakeIssue {
  assignees: string[];
  labels: string[];
  comments: { author: string; body: string }[];
}

export interface FakeGitHub {
  /** The claim host every Brewery uses: refs are the repository's, not a Brewery's. */
  readonly host: ClaimHost;
  /** The message of each claim ref, by `<repo>#<issue>`. */
  readonly refs: Map<string, string>;
  /** The marks on an issue, made empty on first use. */
  issue(repo: string, issue: number): FakeIssue;
  /** How many times each kind of call reached the host. */
  readonly calls: Map<string, number>;
  /**
   * The effect target of `effect`, applied as `login`: found by being there (assignee, label), by
   * the key in a comment of `login`'s, or by a claim ref that is gone.
   */
  target(effect: ClaimEffect, login: string): EffectTarget;
  /** Sets a ref as someone did by hand, or as a run that was killed left it. */
  setRef(repo: string, issue: number, message: string): void;
}

const refKey = (repo: string, issue: number): string => `${repo}#${issue}`;
const marker = (key: string): string => `<!-- foedrum:${key} -->`;

export interface FakeGitHubOptions {
  /** Deletes the ref as it is read, as a release in between would. */
  vanishOnRead?: boolean;
  /** Runs once, right after the first read returns: someone changes the ref in between. */
  afterRead?: (github: FakeGitHub) => void;
}

export const fakeGitHub = (options: FakeGitHubOptions = {}): FakeGitHub => {
  const refs = new Map<string, string>();
  // The commit each ref points at: a new one every time a ref is set.
  const shas = new Map<string, string>();
  let commits = 0;
  const point = (key: string, message: string): void => {
    refs.set(key, message);
    commits++;
    shas.set(key, String(commits).padStart(40, '0'));
  };
  let afterRead = options.afterRead;
  const issues = new Map<string, FakeIssue>();
  const calls = new Map<string, number>();
  const count = (kind: string): void => {
    calls.set(kind, (calls.get(kind) ?? 0) + 1);
  };
  const issue = (repo: string, number: number): FakeIssue => {
    const key = refKey(repo, number);
    const found = issues.get(key) ?? { assignees: [], labels: [], comments: [] };
    issues.set(key, found);
    return found;
  };

  const host: ClaimHost = {
    create: async (repo, number, message) => {
      count('create');
      await Promise.resolve();
      const key = refKey(repo, number);
      if (refs.has(key)) return 'exists';
      point(key, message);
      return 'created';
    },
    read: async (repo, number) => {
      count('read');
      await Promise.resolve();
      const key = refKey(repo, number);
      if (options.vanishOnRead === true) {
        refs.delete(key);
        return undefined;
      }
      const message = refs.get(key);
      const sha = shas.get(key);
      const read = message === undefined || sha === undefined ? undefined : { sha, message };
      const then = afterRead;
      afterRead = undefined;
      then?.(github);
      return read;
    },
    // Atomic, like an update with an expected old value: only while the ref is at `sha`.
    delete: async (repo, number, sha) => {
      count('delete');
      await Promise.resolve();
      const key = refKey(repo, number);
      if (shas.get(key) !== sha) return false;
      refs.delete(key);
      shas.delete(key);
      return true;
    },
  };

  const target = (effect: ClaimEffect, login: string): EffectTarget => {
    const marks = issue(effect.repo, effect.issue);
    switch (effect.kind) {
      case 'assign':
        return {
          find: async () =>
            marks.assignees.includes(effect.login) ? { result: effect.login } : undefined,
          apply: async () => {
            marks.assignees.push(effect.login);
            return effect.login;
          },
        };
      case 'add_label':
        return {
          find: async () => (marks.labels.includes(effect.label) ? { result: null } : undefined),
          apply: async () => {
            marks.labels.push(effect.label);
            return null;
          },
        };
      case 'remove_label':
        return {
          find: async () => (marks.labels.includes(effect.label) ? undefined : { result: null }),
          apply: async () => {
            marks.labels = marks.labels.filter((label) => label !== effect.label);
            return null;
          },
        };
      case 'comment':
        return {
          find: async (key) => {
            const index = marks.comments.findIndex(
              (comment) => comment.author === login && comment.body.includes(marker(key)),
            );
            return index === -1 ? undefined : { result: index };
          },
          apply: async (key) => {
            marks.comments.push({ author: login, body: `${effect.body}\n${marker(key)}` });
            return marks.comments.length - 1;
          },
        };
      case 'release_ref':
        return {
          find: async () =>
            refs.has(refKey(effect.repo, effect.issue)) ? undefined : { result: null },
          // As the GitHub layer does: only a ref whose record names the Brewery goes.
          apply: async () => releaseClaim(host, effect),
        };
      default:
        return effect satisfies never;
    }
  };

  const github: FakeGitHub = {
    host,
    refs,
    issue,
    calls,
    target,
    setRef: (repo, number, message) => {
      point(refKey(repo, number), message);
    },
  };
  return github;
};
