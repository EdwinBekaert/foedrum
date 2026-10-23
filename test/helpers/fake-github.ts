// A fake GitHub for claim tests: one target repository's claim refs and issue marks, shared by
// every Brewery that uses it, with no network (ADR 0021). Creating a ref is atomic, as on GitHub:
// it yields once, so that concurrent claims interleave, and then checks and sets in one step.

import type { IssueMarks } from '../../src/engine/claim-effects.ts';
import type { EffectTarget } from '../../src/engine/effects.ts';
import { type ClaimEffect, type ClaimHost, releaseClaim } from '../../src/engine/issue-claims.ts';

export interface FakeIssue {
  assignees: string[];
  labels: string[];
  comments: { author: string; body: string }[];
  /** Absent: a title the fake makes up from the number. */
  title?: string;
  /** Absent: open. */
  state?: 'open' | 'closed';
  /** Set on an issue `openIssue` opened, with the login that opened it. */
  body?: string;
  author?: string;
}

/** An issue the Brewery opened (ADR 0144). */
export interface OpenedIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed';
}

export interface FakeGitHub {
  /** The claim host every Brewery uses: refs are the repository's, not a Brewery's. */
  readonly host: ClaimHost;
  /** The message of each claim ref, by `<repo>#<issue>`. */
  readonly refs: Map<string, string>;
  /** The marks on an issue, made empty on first use. */
  issue(repo: string, issue: number): FakeIssue;
  /** The issues opened in `repo` through `openIssue`, in the order they were opened. */
  opened(repo: string): OpenedIssue[];
  /** How many times each kind of call reached the host. */
  readonly calls: Map<string, number>;
  /**
   * The effect target of `effect`, applied as `login`: found by being there (assignee, label), by
   * the key in a comment of `login`'s, or by a claim ref that is gone.
   */
  target(effect: ClaimEffect, login: string): EffectTarget;
  /**
   * The issue marks as `login` sees and makes them: its comments are numbered from 1 in the order
   * they were made, and it finds only its own.
   */
  marks(login: string): IssueMarks;
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
  // The numbers of the issues opened in each repository, in order.
  const openedIn = new Map<string, number[]>();
  const opened = (repo: string): OpenedIssue[] =>
    (openedIn.get(repo) ?? []).map((number) => {
      const found = issue(repo, number);
      return {
        number,
        title: found.title ?? '',
        body: found.body ?? '',
        author: found.author ?? '',
        state: found.state ?? 'open',
      };
    });
  /** Opens an issue in `repo` as `login`, numbered after every issue the fake has there. */
  const openIssue = (repo: string, title: string, body: string, login: string): number => {
    const prefix = `${repo}#`;
    const numbers = [...issues.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => Number(key.slice(prefix.length)));
    const number = Math.max(0, ...numbers) + 1;
    issues.set(refKey(repo, number), {
      assignees: [],
      labels: [],
      comments: [],
      title,
      body,
      author: login,
      state: 'open',
    });
    openedIn.set(repo, [...(openedIn.get(repo) ?? []), number]);
    return number;
  };
  /** The issue in `repo` that `login` opened with `marker` in its body. */
  const findIssue = (repo: string, marker: string, login: string): number | undefined =>
    opened(repo).find(({ author, body }) => author === login && body.includes(marker))?.number;
  const titleOf = (repo: string, number: number): string =>
    issue(repo, number).title ?? `Issue ${number}`;

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
      case 'open_order':
        return {
          find: async (key) => {
            const number = findIssue(effect.brewery, marker(key), login);
            return number === undefined ? undefined : { result: number };
          },
          apply: async (key) =>
            openIssue(
              effect.brewery,
              titleOf(effect.repo, effect.issue),
              `${effect.body}
${marker(key)}`,
              login,
            ),
        };
      case 'issue_state':
        return {
          find: async () =>
            (marks.state ?? 'open') === effect.state ? { result: null } : undefined,
          apply: async () => {
            marks.state = effect.state;
            return null;
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

  const marks = (login: string): IssueMarks => ({
    assignees: async (repo, number) => {
      count('assignees');
      return [...issue(repo, number).assignees];
    },
    assign: async (repo, number, assignee) => {
      count('assign');
      const found = issue(repo, number);
      if (!found.assignees.includes(assignee)) found.assignees.push(assignee);
    },
    labels: async (repo, number) => {
      count('labels');
      return [...issue(repo, number).labels];
    },
    addLabel: async (repo, number, label) => {
      count('addLabel');
      const found = issue(repo, number);
      if (!found.labels.includes(label)) found.labels.push(label);
    },
    removeLabel: async (repo, number, label) => {
      count('removeLabel');
      const found = issue(repo, number);
      found.labels = found.labels.filter((name) => name !== label);
    },
    findComment: async (repo, number, marker) => {
      count('findComment');
      const index = issue(repo, number).comments.findIndex(
        (comment) => comment.author === login && comment.body.includes(marker),
      );
      return index === -1 ? undefined : index + 1;
    },
    comment: async (repo, number, body) => {
      count('comment');
      const { comments } = issue(repo, number);
      comments.push({ author: login, body });
      return comments.length;
    },
    title: async (repo, number) => {
      count('title');
      return titleOf(repo, number);
    },
    issueState: async (repo, number) => {
      count('issueState');
      return issue(repo, number).state ?? 'open';
    },
    setIssueState: async (repo, number, state) => {
      count('setIssueState');
      issue(repo, number).state = state;
    },
    findIssue: async (repo, marker) => {
      count('findIssue');
      return findIssue(repo, marker, login);
    },
    openIssue: async (repo, title, body) => {
      count('openIssue');
      return openIssue(repo, title, body, login);
    },
  });

  const github: FakeGitHub = {
    host,
    marks,
    refs,
    issue,
    opened,
    calls,
    target,
    setRef: (repo, number, message) => {
      point(refKey(repo, number), message);
    },
  };
  return github;
};
