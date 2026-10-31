// The tests' fake GitHub API (test/helpers/fake-github-api.ts) answers a pull request it opened as
// GitHub would a fresh one, through the readers serve uses (#721).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';

const api = 'https://api.github.com';

/** The fake with one pull request opened on acme/web, and serve's readers over it. */
const opened = async () => {
  const github = fakeGitHubApi({ login: 'ann', issues: {} });
  const answer = await github.fetch(`${api}/repos/acme/web/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Greet', head: 'foedrum/7', base: 'main', body: 'Closes #7' }),
  });
  const { html_url: url, number } = (await answer.json()) as { html_url: string; number: number };
  const client = createGitHubClient({ exec: ghOver(github.fetch).exec });
  const reads = createGitHubReads(client);
  return { github, url, number, reads, client };
};

describe('the fake GitHub API', () => {
  it('answers 404 to a pull request it never opened (regression test)', async () => {
    const { github, number } = await opened();
    const answer = await github.fetch(`${api}/repos/acme/web/pulls/${number + 1}`);
    assert.equal(answer.status, 404);
  });
});
