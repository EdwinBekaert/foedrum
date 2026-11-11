// What a claimed issue's history says of it since its approval (ADR 0368): when each label was
// added and by whom, and each change of its title, from its events (REST, conditional, ADR 0052);
// each edit of its body, which only GraphQL tells; and when each comment was made and last changed.

import type { OrderActivity } from '../engine/order-changes.ts';
import { GitHubActivityComment, GitHubIssueEdits, GitHubIssueEvent } from '../schemas/github.ts';
import { checked, graphqlData, repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';
import { type GitHubReads, pageSize } from './reads.ts';

// A page of 100 edits, and the time of the latest, which counts by nobody known when no edit of the
// page has it.
const EDITS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      lastEditedAt
      userContentEdits(first: 100) { pageInfo { hasNextPage } nodes { editedAt editor { login } } }
    }
  }
}`;

/**
 * Reads the events of `repo#issue`, every page: when each label was added and by whom, and each
 * change of its title, oldest first.
 */
export const githubOrderEvents =
  (reads: GitHubReads) =>
  async (
    repo: string,
    issue: number,
    signal?: AbortSignal,
  ): Promise<Pick<OrderActivity, 'labelled' | 'renamed'>> => {
    const path = `/repos/${repoPath(repo)}/issues/${issue}`;
    const happened = `the events of ${repo}#${issue}`;
    const events = (await reads.pages(`${path}/events?per_page=100`, happened, signal))
      .map((item) => checked(GitHubIssueEvent, item, happened))
      .sort((one, other) => one.id - other.id);
    const timed = (
      event: string,
    ): { by: string | undefined; at: string; label: string | undefined }[] =>
      events
        .filter((each) => each.event === event)
        .map(({ actor, created_at: at, label }) => {
          if (at === undefined)
            throw new Error(`${happened} has a ${event} event without its time`);
          return { by: actor?.login, at, label: label?.name };
        });
    const labelled = timed('labeled').map(({ label, by, at }) => {
      if (label === undefined) throw new Error(`${happened} has a labeled event without its label`);
      return { label, by, at };
    });
    const renamed = timed('renamed').map(({ by, at }) => ({ by, at }));
    return { labelled, renamed };
  };

/** Reads the activity of `repo#issue` the order check compares with its approval. */
export const githubOrderActivity =
  (reads: GitHubReads, client: Pick<GitHubClient, 'graphql'>) =>
  async (repo: string, issue: number, signal?: AbortSignal): Promise<OrderActivity> => {
    const path = `/repos/${repoPath(repo)}/issues/${issue}`;
    const { labelled, renamed } = await githubOrderEvents(reads)(repo, issue, signal);

    const editing = `the edits of ${repo}#${issue}`;
    const [owner, name] = repo.split('/');
    const answer = await client.graphql(EDITS, { owner, name, number: issue }, signal);
    const { lastEditedAt, userContentEdits } = checked(
      GitHubIssueEdits,
      graphqlData(answer, editing),
      editing,
    ).repository.issue;
    const edited = userContentEdits.nodes.map(({ editedAt, editor }) => ({
      by: editor?.login,
      at: editedAt,
    }));
    // The latest edit counts even when the history lists none at its time, past its first page or
    // left out of it, by nobody known.
    const listed = (at: string) => edited.some((edit) => Date.parse(edit.at) === Date.parse(at));
    if (lastEditedAt !== null && !listed(lastEditedAt)) {
      edited.push({ by: undefined, at: lastEditedAt });
    }

    const said = `the comments of ${repo}#${issue}`;
    const comments = (await reads.pages(`${path}/comments?per_page=${pageSize}`, said, signal)).map(
      (item) => {
        const comment = checked(GitHubActivityComment, item, said);
        return {
          id: comment.id,
          by: comment.user?.login,
          association: comment.author_association,
          created: comment.created_at,
          updated: comment.updated_at,
          body: comment.body,
        };
      },
    );
    return { labelled, renamed, edited, comments };
  };
