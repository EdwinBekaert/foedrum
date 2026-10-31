// The tests' fake GitHub API (test/helpers/fake-github-api.ts) answers a pull request it opened as
// GitHub would a fresh one, through the readers serve uses (#721).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { githubCheckReader } from '../../src/github/checks.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { githubTargetTracker } from '../../src/github/tracker.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi, headOf } from '../helpers/fake-github-api.ts';

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
  it('answers a pull request it opened by its number', async () => {
    const { github, url, number, reads } = await opened();
    assert.equal(await githubTargetTracker(reads).pullRequest(url), 'open');
    const answer = await github.fetch(`${api}/repos/acme/web/pulls/${number}`);
    assert.equal(answer.status, 200);
    const pull = (await answer.json()) as {
      number: number;
      html_url: string;
      body: string;
      head: { ref: string; sha: string };
    };
    assert.deepStrictEqual(
      { number: pull.number, url: pull.html_url, body: pull.body, ref: pull.head.ref },
      { number, url, body: 'Closes #7', ref: 'foedrum/7' },
    );
    assert.match(pull.head.sha, /^[0-9a-f]{40}$/);
  });

  it("answers the check runs of a fresh pull request's head as none", async () => {
    const { url, reads, client } = await opened();
    const reader = githubCheckReader(reads, client);
    const head = await reader.head(url);
    assert.deepStrictEqual(await reader.checks(url, head), []);
  });

  it('answers 404 to a pull request it never opened (regression test)', async () => {
    const { github, number } = await opened();
    const answer = await github.fetch(`${api}/repos/acme/web/pulls/${number + 1}`);
    assert.equal(answer.status, 404);
  });

  it('answers 404 to a change of a pull request it opened, which it does not make (regression test)', async () => {
    const { github, number } = await opened();
    const answer = await github.fetch(`${api}/repos/acme/web/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: 'Closes #7, again' }),
    });
    assert.equal(answer.status, 404);
  });

  it('answers 404 to the checks of a commit no pull request it opened heads (regression test)', async () => {
    const { github, number } = await opened();
    for (const sha of [headOf(number + 1), headOf(number).replace(/^e/, 'a')]) {
      const answer = await github.fetch(`${api}/repos/acme/web/commits/${sha}/check-runs`);
      assert.equal(answer.status, 404, sha);
    }
    const ours = await github.fetch(`${api}/repos/acme/web/commits/${headOf(number)}/status`);
    assert.equal(ours.status, 200);
  });
});
