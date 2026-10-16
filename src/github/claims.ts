// The claim ref of a target-repository issue on GitHub (ADR 0043): created through the REST API,
// which refuses a ref that exists, so of any number of Breweries exactly one creates it; read back
// with its commit's message, the claim record; and deleted only while it still points at the
// commit that was read, in one step through GraphQL `updateRefs` with `beforeOid`. The opt-in
// integration test proves that on GitHub itself (test/integration/github-claims.test.ts).

import type { ClaimHost } from '../engine/issue-claims.ts';
import { claimRef } from '../engine/issue-claims.ts';
import { Repo } from '../schemas/events.ts';
import { GitCommit, GitHubError, GitRef, RepositoryId } from '../schemas/github.ts';
import { CommitSha } from '../schemas/store.ts';
import type { z } from '../schemas/zod.ts';
import type { GitHubClient } from './client.ts';

/** git's empty tree: every claim commit has it, and no parent. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** `afterOid` of an update that deletes the ref. */
const DELETED = '0'.repeat(40);

const UPDATE_REFS = `mutation ($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}`;
const REPOSITORY_ID = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id }
}`;

// `owner/name` as path segments; checked first, since it becomes part of a URL.
const repoPath = (repo: string): string => {
  if (!Repo.safeParse(repo).success)
    throw new Error(`The repository must be owner/name, got ${repo}`);
  return repo.split('/').map(encodeURIComponent).join('/');
};

const checked = <T>(schema: z.ZodType<T>, body: unknown, what: string): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`GitHub's answer to ${what} is not what it should be`);
  return parsed.data;
};

const refused = (status: number, body: unknown, what: string): Error => {
  const parsed = GitHubError.safeParse(body);
  const said = parsed.success ? `: ${parsed.data.message}` : '';
  return new Error(`GitHub answered ${status} to ${what}${said}`);
};

export const githubClaimHost = (client: GitHubClient): ClaimHost => {
  const ids = new Map<string, string>();
  const repositoryId = async (repo: string, signal?: AbortSignal): Promise<string> => {
    const known = ids.get(repo.toLowerCase());
    if (known !== undefined) return known;
    const [owner, name] = repo.split('/');
    const answer = await client.graphql(REPOSITORY_ID, { owner, name }, signal);
    if (answer.errors.length > 0) {
      throw new Error(`GitHub could not find ${repo}: ${answer.errors[0]?.message}`);
    }
    const { id } = checked(RepositoryId, answer.data, `the id of ${repo}`).repository;
    ids.set(repo.toLowerCase(), id);
    return id;
  };

  const read: ClaimHost['read'] = async (repo, issue, signal) => {
    const path = `/repos/${repoPath(repo)}/git/${claimRef(issue).replace(/^refs\//, 'ref/')}`;
    const what = `reading ${claimRef(issue)} of ${repo}`;
    const ref = await client.rest('GET', path, undefined, signal);
    if (ref.status === 404) return undefined;
    if (ref.status !== 200) throw refused(ref.status, ref.body, what);
    const { object } = checked(GitRef, ref.body, what);
    // Not a commit: nothing that names a Brewery, so it is someone unknown's.
    if (object.type !== 'commit') return { sha: object.sha, message: '' };
    const commitPath = `/repos/${repoPath(repo)}/git/commits/${object.sha}`;
    const commit = await client.rest('GET', commitPath, undefined, signal);
    if (commit.status !== 200) throw refused(commit.status, commit.body, what);
    return { sha: object.sha, message: checked(GitCommit, commit.body, what).message ?? '' };
  };

  return {
    create: async (repo, issue, message, signal) => {
      const base = `/repos/${repoPath(repo)}/git`;
      const ref = claimRef(issue);
      const made = await client.rest(
        'POST',
        `${base}/commits`,
        { message, tree: EMPTY_TREE, parents: [] },
        signal,
      );
      if (made.status !== 201) throw refused(made.status, made.body, `the claim commit in ${repo}`);
      const { sha } = checked(GitCommit, made.body, `the claim commit in ${repo}`);
      const created = await client.rest('POST', `${base}/refs`, { ref, sha }, signal);
      if (created.status === 201) return 'created';
      const error = GitHubError.safeParse(created.body);
      if (
        created.status === 422 &&
        error.success &&
        error.data.message === 'Reference already exists'
      ) {
        return 'exists';
      }
      throw refused(created.status, created.body, `creating ${ref} in ${repo}`);
    },
    read,
    delete: async (repo, issue, sha, signal) => {
      repoPath(repo);
      if (!CommitSha.safeParse(sha).success) throw new Error(`Not a full commit sha: ${sha}`);
      const input = {
        repositoryId: await repositoryId(repo, signal),
        refUpdates: [{ name: claimRef(issue), beforeOid: sha, afterOid: DELETED, force: false }],
      };
      const answer = await client.graphql(UPDATE_REFS, { input }, signal);
      if (answer.errors.length === 0) return true;
      // GitHub answers a ref that moved with an opaque error, as it does a fault of its own: the
      // ref tells them apart.
      const now = await read(repo, issue, signal);
      if (now === undefined || now.sha !== sha) return false;
      throw new Error(
        `GitHub did not delete ${claimRef(issue)} of ${repo}: ${answer.errors.map((error) => error.message).join('; ')}`,
      );
    },
  };
};
