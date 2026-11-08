// The pull requests of the openPullRequest action on GitHub (ADR 0071), and the order's title, from
// synthetic answers in the shapes of GitHub's REST documentation through a fake `fetch`; no
// network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubOrderTitle } from '../../src/github/order-text.ts';
import { githubPullRequestDrafts, githubPullRequests } from '../../src/github/pull-requests.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const head = 'foedrum/acme.brewery/12-1/acme.api';
const url = 'https://github.com/acme/api/pull/9';
/** A pull request as `GET /repos/{owner}/{repo}/pulls` lists it. */
const listed = (
  fields: { login?: string | null; ref?: string; repo?: string | null; url?: string } = {},
) => {
  const { login = 'brewer-bot', ref = head, repo = 'acme/api' } = fields;
  return {
    number: 9,
    html_url: fields.url ?? url,
    state: 'open',
    user: login === null ? null : { login },
    head: { ref, repo: repo === null ? null : { full_name: repo } },
  };
};

const hostWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  let logins = 0;
  const host = githubPullRequests({
    client,
    reads: createGitHubReads(client),
    login: async () => {
      logins++;
      return 'Brewer-Bot';
    },
  });
  return { host, ...fake, logins: () => logins };
};

describe('githubPullRequests: find', () => {
  it("lists the repository's pull requests from the head branch, open or closed", async () => {
    const { host, requests } = hostWith([{ status: 200, body: [listed()] }]);
    assert.equal(await host.find('acme/api', head), url);
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      [
        `GET https://api.github.com/repos/acme/api/pulls?state=all&head=acme%3A${encodeURIComponent(head)}&per_page=10`,
      ],
    );
  });

  it("counts only the Brewery's own login, from the repository itself, on that very branch", async () => {
    const others = [
      listed({ login: 'mallory' }),
      listed({ login: null }),
      listed({ repo: 'mallory/api' }),
      listed({ repo: null }),
      listed({ ref: `${head}-2` }),
    ];
    const none = hostWith([{ status: 200, body: others }]);
    assert.equal(await none.host.find('acme/api', head), undefined);
    const ours = hostWith([
      { status: 200, body: [...others, listed({ url: 'https://github.com/acme/api/pull/10' })] },
    ]);
    assert.equal(await ours.host.find('acme/api', head), 'https://github.com/acme/api/pull/10');
  });

  it("fails with GitHub's status and message when the list cannot be read", async () => {
    const { host } = hostWith([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(
      host.find('acme/api', head),
      /GitHub answered 404 .*acme\/api.*: Not Found/,
    );
  });
});

describe('githubPullRequests: the login', () => {
  it('reads the login again after a read that failed', async () => {
    const fake = fakeFetch([
      { status: 200, body: [listed()] },
      { status: 200, body: [listed()] },
    ]);
    const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
    let logins = 0;
    const host = githubPullRequests({
      client,
      reads: createGitHubReads(client),
      login: async () => {
        logins++;
        if (logins === 1) throw new Error('GitHub did not answer');
        return 'brewer-bot';
      },
    });
    await assert.rejects(host.find('acme/api', head), /GitHub did not answer/);
    assert.equal(await host.find('acme/api', head), url);
    assert.equal(logins, 2);
  });
});

describe('githubPullRequests: open', () => {
  const request = { head, base: 'main', title: 'Add a --json flag', body: 'Closes acme/api#7' };

  it('opens it from the branch of the repository itself, and gives its URL', async () => {
    const { host, requests } = hostWith([{ status: 201, body: listed() }]);
    assert.equal(await host.open('acme/api', request), url);
    assert.equal(requests[0]?.method, 'POST');
    assert.equal(requests[0]?.url, 'https://api.github.com/repos/acme/api/pulls');
    assert.deepEqual(requests[0]?.body, {
      title: 'Add a --json flag',
      head,
      base: 'main',
      body: 'Closes acme/api#7',
      maintainer_can_modify: false,
      draft: false,
    });
  });

  it('opens it as a draft when asked (ADR 0167)', async () => {
    const { host, requests } = hostWith([{ status: 201, body: listed() }]);
    assert.equal(await host.open('acme/api', { ...request, draft: true }), url);
    assert.equal((requests[0]?.body as { draft?: boolean } | undefined)?.draft, true);
  });

  it('opens it ready once GitHub says the repository cannot have a draft (ADR 0167)', async () => {
    const refusal = {
      message: 'Validation Failed',
      errors: [
        {
          resource: 'PullRequest',
          code: 'custom',
          message: 'Draft pull requests are not supported in this repository.',
        },
      ],
    };
    const { host, requests } = hostWith([
      { status: 422, body: refusal },
      { status: 201, body: listed() },
    ]);
    assert.equal(await host.open('acme/api', { ...request, draft: true }), url);
    assert.deepEqual(
      requests.map(({ body }) => (body as { draft?: boolean }).draft),
      [true, false],
    );
  });

  it('asks only once when GitHub lists another error for the draft (review of #450)', async () => {
    const refusal = {
      message: 'Validation Failed',
      errors: [
        { resource: 'PullRequest', code: 'custom', message: `No commits between main and ${head}` },
      ],
    };
    const { host, requests } = hostWith([
      { status: 422, body: refusal },
      { status: 201, body: listed() },
    ]);
    await assert.rejects(host.open('acme/api', { ...request, draft: true }), /422/);
    assert.equal(requests.length, 1);
  });

  it('asks only once when GitHub refuses a draft for another reason', async () => {
    const { host, requests } = hostWith([
      { status: 422, body: { message: 'Validation Failed' } },
      { status: 201, body: listed() },
    ]);
    await assert.rejects(host.open('acme/api', { ...request, draft: true }), /422/);
    assert.equal(requests.length, 1);
  });

  it("fails with GitHub's message when it refuses, as for a branch without commits", async () => {
    const { host } = hostWith([{ status: 422, body: { message: 'Validation Failed' } }]);
    await assert.rejects(
      host.open('acme/api', request),
      /GitHub answered 422 to opening a pull request from .* in acme\/api: Validation Failed/,
    );
  });

  it('fails on an answer that is no pull request', async () => {
    const { host } = hostWith([{ status: 201, body: { number: 'nine' } }]);
    await assert.rejects(host.open('acme/api', request), /opening a pull request/);
  });

  it('reads the login once, when it is first needed', async () => {
    const { host, logins } = hostWith([
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);
    assert.equal(logins(), 0);
    await host.find('acme/api', head);
    await host.find('acme/web', head);
    assert.equal(logins(), 1);
  });
});

describe('githubPullRequests: the body (ADR 0227)', () => {
  const pull = (body: string | null) => ({ number: 9, state: 'open', body });

  it('reads the body of the pull request at its URL, and an empty one as no text', async () => {
    const { host, requests } = hostWith([
      { status: 200, body: pull('How it works') },
      { status: 200, body: pull(null) },
    ]);
    assert.equal(await host.body(url), 'How it works');
    assert.equal(await host.body(url), '');
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      [
        'GET https://api.github.com/repos/acme/api/pulls/9',
        'GET https://api.github.com/repos/acme/api/pulls/9',
      ],
    );
  });

  it("fails with GitHub's status and message when the pull request cannot be read", async () => {
    const { host } = hostWith([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(host.body(url), /GitHub answered 404 .*acme\/api#9.*: Not Found/);
  });

  it('updates the body only: never the title, the draft state or anything else', async () => {
    const { host, requests } = hostWith([{ status: 200, body: pull('New') }]);
    await host.update(url, 'New');
    assert.equal(requests[0]?.method, 'PATCH');
    assert.equal(requests[0]?.url, 'https://api.github.com/repos/acme/api/pulls/9');
    assert.deepEqual(requests[0]?.body, { body: 'New' });
  });

  it("fails with GitHub's status and message when the update is refused", async () => {
    const { host } = hostWith([{ status: 403, body: { message: 'Resource not accessible' } }]);
    await assert.rejects(
      host.update(url, 'New'),
      /GitHub answered 403 .*acme\/api#9.*: Resource not accessible/,
    );
  });
});

describe('githubOrderTitle', () => {
  const issue = { number: 12, state: 'open', user: { login: 'octocat' }, labels: [] };

  it("reads a Brewery issue's title in the Brewery, a claimed issue's in its repository", async () => {
    const fake = fakeFetch([
      { status: 200, body: { ...issue, title: 'Add a --json flag' } },
      { status: 200, body: { ...issue, number: 7, title: 'Dark theme' } },
    ]);
    const reads = createGitHubReads(createGitHubClient({ exec: ghOver(fake.fetch).exec }));
    const title = githubOrderTitle(reads, 'acme/brewery');
    assert.equal(await title({ issue: 12 }), 'Add a --json flag');
    assert.equal(await title({ issue: 7, repo: 'acme/web' }), 'Dark theme');
    assert.deepEqual(
      fake.requests.map(({ url }) => url),
      [
        'https://api.github.com/repos/acme/brewery/issues/12',
        'https://api.github.com/repos/acme/web/issues/7',
      ],
    );
  });

  it('gives an empty title for an answer without one, and fails for another issue', async () => {
    const fake = fakeFetch([
      { status: 200, body: issue },
      { status: 200, body: { ...issue, number: 8, title: 'Other' } },
    ]);
    const reads = createGitHubReads(createGitHubClient({ exec: ghOver(fake.fetch).exec }));
    const title = githubOrderTitle(reads, 'acme/brewery');
    assert.equal(await title({ issue: 12 }), '');
    await assert.rejects(
      title({ issue: 12 }),
      /GitHub answered issue #8 to the issue acme\/brewery#12/,
    );
  });
});

describe('githubPullRequestDrafts (ADR 0350)', () => {
  const graphql = 'https://api.github.com/graphql';
  /** A pull request as `GET /repos/{owner}/{repo}/pulls/{n}` answers it. */
  const pull = (draft: boolean, nodeId: string | undefined = 'PR_9') => ({
    state: 'open',
    draft,
    ...(nodeId === undefined ? {} : { node_id: nodeId }),
  });
  const draftsWith = (answers: Answer[]) => {
    const fake = fakeFetch(answers);
    const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
    return {
      drafts: githubPullRequestDrafts({ client, reads: createGitHubReads(client) }),
      ...fake,
    };
  };
  /** The query and variables of a GraphQL request. */
  const asked = (request: { body?: unknown } | undefined) =>
    request?.body as { query: string; variables: unknown };

  it('reads whether the pull request is a draft', async () => {
    const { drafts, requests } = draftsWith([
      { status: 200, body: pull(true) },
      { status: 200, body: pull(false) },
    ]);
    assert.equal(await drafts.isDraft(url), true);
    assert.equal(await drafts.isDraft(url), false);
    assert.equal(requests[0]?.url, 'https://api.github.com/repos/acme/api/pulls/9');
  });

  it('marks it ready for review by its node id', async () => {
    const { drafts, requests } = draftsWith([
      { status: 200, body: pull(true) },
      {
        status: 200,
        body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } },
      },
    ]);
    await drafts.markReady(url);
    assert.equal(requests[1]?.url, graphql);
    const { query, variables } = asked(requests[1]);
    assert.match(query, /markPullRequestReadyForReview/);
    assert.deepStrictEqual(variables, { input: { pullRequestId: 'PR_9' } });
  });

  it('turns it back into a draft by its node id', async () => {
    const { drafts, requests } = draftsWith([
      { status: 200, body: pull(false) },
      {
        status: 200,
        body: { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } },
      },
    ]);
    assert.equal(await drafts.markDraft(url), 'draft');
    const { query, variables } = asked(requests[1]);
    assert.match(query, /convertPullRequestToDraft/);
    assert.deepStrictEqual(variables, { input: { pullRequestId: 'PR_9' } });
  });

  it('says draftless when GitHub says the repository cannot have drafts', async () => {
    const { drafts } = draftsWith([
      { status: 200, body: pull(false) },
      {
        status: 200,
        body: {
          data: { convertPullRequestToDraft: null },
          errors: [{ message: 'Draft pull requests are not supported in this repository.' }],
        },
      },
    ]);
    assert.equal(await drafts.markDraft(url), 'draftless');
  });

  it('fails on another GraphQL error, an answer it did not expect, or a refused read', async () => {
    const { drafts } = draftsWith([
      { status: 200, body: pull(false) },
      {
        status: 200,
        body: { data: { convertPullRequestToDraft: null }, errors: [{ message: 'Forbidden' }] },
      },
      { status: 200, body: pull(true) },
      { status: 200, body: { data: { markPullRequestReadyForReview: null } } },
      { status: 200, body: pull(true, undefined) },
      { status: 404, body: { message: 'Not Found' } },
    ]);
    await assert.rejects(drafts.markDraft(url), /Forbidden/);
    await assert.rejects(drafts.markReady(url), /not what it should be/);
    await assert.rejects(drafts.markReady(url), /no node id/);
    await assert.rejects(drafts.isDraft(url), /404.*acme\/api.*Not Found/);
  });
});
