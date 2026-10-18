// The pull requests of the openPullRequest action on GitHub (ADR 0071), and the order's title, from
// synthetic answers in the shapes of GitHub's REST documentation through a fake `fetch`; no
// network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubOrderTitle } from '../../src/github/order-text.ts';
import { githubPullRequests } from '../../src/github/pull-requests.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';

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
  const client = createGitHubClient({ token: 'ghp_test', fetch: fake.fetch });
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
    const client = createGitHubClient({ token: 'ghp_test', fetch: fake.fetch });
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
    });
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

describe('githubOrderTitle', () => {
  const issue = { number: 12, state: 'open', user: { login: 'octocat' }, labels: [] };

  it("reads a Brewery issue's title in the Brewery, a claimed issue's in its repository", async () => {
    const fake = fakeFetch([
      { status: 200, body: { ...issue, title: 'Add a --json flag' } },
      { status: 200, body: { ...issue, number: 7, title: 'Dark theme' } },
    ]);
    const reads = createGitHubReads(createGitHubClient({ token: 'ghp_test', fetch: fake.fetch }));
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
    const reads = createGitHubReads(createGitHubClient({ token: 'ghp_test', fetch: fake.fetch }));
    const title = githubOrderTitle(reads, 'acme/brewery');
    assert.equal(await title({ issue: 12 }), '');
    await assert.rejects(
      title({ issue: 12 }),
      /GitHub answered issue #8 to the issue acme\/brewery#12/,
    );
  });
});
