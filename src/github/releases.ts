// A repository's latest release on GitHub (ADR 0223): its latest published release, else its newest
// tag by its commit's date, and whether it holds a pull request's merge commit. REST reads are
// conditional (ADR 0052); everything it reads is untrusted input, checked field by field.

import type { LatestRelease, ReleaseReader } from '../engine/releases.ts';
import {
  GitHubCompare,
  GitHubGitCommit,
  GitHubLatestRelease,
  GitHubLatestTag,
  GitHubPullRequest,
} from '../schemas/github.ts';
import { z } from '../schemas/zod.ts';
import { checked, refused, repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';
import type { GitHubReads } from './reads.ts';
import { pullRequestOf } from './tracker.ts';

/** The longest tag name a release record keeps. */
const MAX_TAG_LENGTH = 255;

/** The newest tag by its commit's date: REST's tag list promises no order. */
const LATEST_TAG = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: 1, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
      nodes {
        name
        target {
          ... on Commit { committedDate }
          ... on Tag { target { ... on Commit { committedDate } } }
        }
      }
    }
  }
}`;

/** Whether `name` is a valid ref name under `refs/tags/`, by git's `check-ref-format` rules. */
const isRefName = (name: string): boolean =>
  name !== '' &&
  name !== '@' &&
  // No control character or space, no `~ ^ : ? * [ \`, `..` or `@{`.
  ![...name].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  }) &&
  !/[~^:?*[\\]|\.\.|@\{/.test(name) &&
  !name.endsWith('.') &&
  name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));

/** A tag's name as a version a record keeps, or an error that says why it is not one. */
const versionOf = (name: string, repo: string): string => {
  if (name.length > MAX_TAG_LENGTH) {
    throw new Error(`The latest tag of ${repo} is longer than ${MAX_TAG_LENGTH} characters`);
  }
  if (!isRefName(name)) {
    throw new Error(`The latest tag of ${repo}, ${JSON.stringify(name)}, is no valid ref name`);
  }
  return name;
};

const Moment = z.iso.datetime({ offset: true });

export const githubReleaseReader = (reads: GitHubReads, client: GitHubClient): ReleaseReader => {
  /** The newest tag of `repo` and its commit's date; none when it has no tag. */
  const latestTag = async (repo: string, signal?: AbortSignal) => {
    const what = `the latest tag of ${repo}`;
    const [owner, name] = repoPath(repo).split('/');
    const answer = await client.graphql(LATEST_TAG, { owner, name }, signal);
    if (answer.errors.length > 0) {
      throw new Error(`GitHub could not read ${what}: ${answer.errors[0]?.message}`);
    }
    const [tag] = checked(GitHubLatestTag, answer.data, what).repository.refs.nodes;
    if (tag === undefined) return undefined;
    const version = versionOf(tag.name, repo);
    const target = tag.target;
    // Never read as no release: the wait it holds up would show nowhere.
    if (target === undefined) {
      throw new Error(`The latest tag of ${repo}, ${JSON.stringify(version)}, points at no commit`);
    }
    const date = 'committedDate' in target ? target.committedDate : target.target.committedDate;
    return { version, published: new Date(date).toISOString(), tag: true };
  };

  /** When the merge commit `merge` was committed: git's data API, which lists no files. */
  const mergeCommitDate = async (path: string, merge: string, signal?: AbortSignal) => {
    const what = `the merge commit ${merge}`;
    const answer = await reads.get(`/repos/${path}/git/commits/${merge}`, signal);
    if (answer.status !== 200) throw refused(answer.status, answer.body, what);
    return checked(GitHubGitCommit, answer.body, what).committer.date;
  };

  return {
    latest: async (repo, signal): Promise<LatestRelease | undefined> => {
      const what = `the latest release of ${repo}`;
      const answer = await reads.get(`/repos/${repoPath(repo)}/releases/latest`, signal);
      // No published release: its newest tag, as ADR 0013 orders them.
      if (answer.status === 404) return latestTag(repo, signal);
      if (answer.status !== 200) throw refused(answer.status, answer.body, what);
      const release = checked(GitHubLatestRelease, answer.body, what);
      return {
        version: versionOf(release.tag_name, repo),
        published: new Date(release.published_at).toISOString(),
      };
    },
    holds: async (repo, release, url, signal) => {
      const pull = pullRequestOf(url);
      if (pull.repo.toLowerCase() !== repo.toLowerCase()) return false;
      const what = `the pull request ${pull.repo}#${pull.number}`;
      const path = repoPath(pull.repo);
      const answer = await reads.get(`/repos/${path}/pulls/${pull.number}`, signal);
      if (answer.status !== 200) throw refused(answer.status, answer.body, what);
      const { merged_at: mergedAt, merge_commit_sha: merge } = checked(
        GitHubPullRequest,
        answer.body,
        what,
      );
      if (mergedAt == null || merge == null) return false;
      // A release published before the merge cannot hold it; a tag's date is its commit's, set
      // where it was made, so it goes by the merge commit's own, which a local merge sets before
      // its push. Either way no compare, whose answer lists every commit since (ADR 0223).
      const since = release.tag
        ? await mergeCommitDate(path, merge, signal)
        : checked(Moment, mergedAt, what);
      if (Date.parse(release.published) < Date.parse(since)) return false;
      const compare = `/repos/${path}/compare/${encodeURIComponent(release.version)}...${merge}?per_page=1`;
      const whatCompared = `the compare of ${release.version} with ${merge} in ${pull.repo}`;
      const compared = await reads.get(compare, signal);
      if (compared.status !== 200) throw refused(compared.status, compared.body, whatCompared);
      const { status } = checked(GitHubCompare, compared.body, whatCompared);
      return status === 'behind' || status === 'identical';
    },
  };
};
