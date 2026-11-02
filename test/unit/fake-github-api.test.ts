// The tests' fake GitHub API (test/helpers/fake-github-api.ts) answers a pull request it opened as
// GitHub would a fresh one, through the readers serve uses (#721).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { githubCheckReader } from '../../src/github/checks.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubPullRequests } from '../../src/github/pull-requests.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { githubReleaseReader } from '../../src/github/releases.ts';
import { repositoryVisibilities } from '../../src/github/repository-visibility.ts';
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

/** The times the tests merge and release at, in order. */
const [T0, T1, T2, T3] = [
  '2026-11-02T09:00:00.000Z',
  '2026-11-02T10:00:00.000Z',
  '2026-11-02T11:00:00.000Z',
  '2026-11-02T12:00:00.000Z',
];
/** A merge commit, a tagged commit and a later merge, none a commit the fake makes itself. */
const MERGE = 'a'.repeat(40);
const TAGGED = 'b'.repeat(40);
const LATER = 'c'.repeat(40);

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
    assert.equal(pull.head.sha, headOf(number));
  });

  it("answers the check runs of a fresh pull request's head as none", async () => {
    const { url, reads, client } = await opened();
    const reader = githubCheckReader(reads, client);
    const head = await reader.head(url);
    assert.deepStrictEqual(await reader.checks(url, head), []);
  });

  it('heads each pull request it opens on a commit no other pull request heads', () => {
    // A padding that is itself a hex digit would give 0x1 and 0xe1 one sha.
    const pairs = [
      [0x1, 0xe1],
      [0xe, 0xee],
      [0x2, 0x2e],
    ] as const;
    for (const [one, other] of pairs) {
      assert.notEqual(headOf(one), headOf(other), `${one} and ${other}`);
    }
  });

  it('answers 404 to a pull request it never opened (regression test)', async () => {
    const { github, number } = await opened();
    const answer = await github.fetch(`${api}/repos/acme/web/pulls/${number + 1}`);
    assert.equal(answer.status, 404);
  });

  it('answers 404 to a change of a pull request it never opened (regression test)', async () => {
    const { github, number } = await opened();
    const answer = await github.fetch(`${api}/repos/acme/web/pulls/${number + 1}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: 'Closes #7, again' }),
    });
    assert.equal(answer.status, 404);
  });

  it('revises the body of a pull request it opened', async () => {
    const { github, url, number, client, reads } = await opened();
    const host = githubPullRequests({ client, reads, login: async () => 'ann' });
    await host.update(url, 'Closes #7, again');
    assert.equal(await host.body(url), 'Closes #7, again');
    assert.equal(github.pulls.find((pull) => pull.number === number)?.body, 'Closes #7, again');
  });

  it('marks a pull request it opened merged, with its merge commit and its date', async () => {
    const { github, url, number, reads } = await opened();
    github.merge('acme/web', number, { sha: MERGE, at: T1 });
    assert.equal(await githubTargetTracker(reads).pullRequest(url), 'merged');
    const pull = (await (await github.fetch(`${api}/repos/acme/web/pulls/${number}`)).json()) as {
      state: string;
      merged: boolean;
      merged_at: string;
      merge_commit_sha: string;
    };
    assert.deepStrictEqual(
      { state: pull.state, merged: pull.merged, at: pull.merged_at, sha: pull.merge_commit_sha },
      { state: 'closed', merged: true, at: T1, sha: MERGE },
    );
    const commit = (await (
      await github.fetch(`${api}/repos/acme/web/git/commits/${MERGE}`)
    ).json()) as {
      committer: { date: string };
    };
    assert.equal(commit.committer.date, T1);
  });

  it('refuses to merge a pull request it never opened', async () => {
    const { github, number } = await opened();
    assert.throws(() => github.merge('acme/web', number + 1, { sha: MERGE, at: T1 }), /acme\/web#/);
  });

  it('answers the visibility it was given of each repository, and of no other', async () => {
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {},
      visibilities: { 'acme/lib': 'public', 'acme/web': 'internal', 'acme/api': 'private' },
    });
    const client = createGitHubClient({ exec: ghOver(github.fetch).exec });
    const repos = ['acme/lib', 'acme/web', 'acme/api', 'acme/docs'];
    const visibilities = repositoryVisibilities(client, repos);
    await visibilities.read();
    assert.deepStrictEqual(
      repos.map((repo) => visibilities.of(repo)),
      ['public', 'internal', 'private', 'unknown'],
    );
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

  it('answers 404 to a pull request it opened and its head, asked for in another repository (regression test)', async () => {
    const { github, number } = await opened();
    const pull = await github.fetch(`${api}/repos/acme/api/pulls/${number}`);
    assert.equal(pull.status, 404);
    const runs = await github.fetch(`${api}/repos/acme/api/commits/${headOf(number)}/check-runs`);
    assert.equal(runs.status, 404);
    const ours = await github.fetch(`${api}/repos/ACME/Web/pulls/${number}`);
    assert.equal(ours.status, 200);
  });

  it('answers 404 to a write of the checks on the head of a pull request it opened (regression test)', async () => {
    const { github, number } = await opened();
    const answer = await github.fetch(`${api}/repos/acme/web/commits/${headOf(number)}/status`, {
      method: 'POST',
      body: JSON.stringify({ state: 'success', context: 'ci' }),
    });
    assert.equal(answer.status, 404);
  });
});

describe("the fake GitHub API's releases", () => {
  /** The fake with one pull request of acme/lib merged at T1, and the release reader over it. */
  const merged = async () => {
    const github = fakeGitHubApi({ login: 'ann', issues: {} });
    const answer = await github.fetch(`${api}/repos/acme/lib/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Greet', head: 'foedrum/7', base: 'main', body: 'B' }),
    });
    const { html_url: url, number } = (await answer.json()) as { html_url: string; number: number };
    github.merge('acme/lib', number, { sha: MERGE, at: T1 });
    const client = createGitHubClient({ exec: ghOver(github.fetch).exec });
    const reader = githubReleaseReader(createGitHubReads(client), client);
    return { github, url, number, reader };
  };

  it('answers its latest published release, with its page and notes, to the release reader', async () => {
    const { github, reader } = await merged();
    // Made out of order: the latest is the one published last, not the one made last.
    github.release('acme/lib', { tag: 'v1.4.0', commit: TAGGED, at: T2, notes: 'French' });
    github.release('acme/lib', { tag: 'v1.3.1', commit: LATER, at: T0, notes: 'Backport' });
    github.release('acme/lib', { tag: 'v1.5.0-rc', commit: LATER, at: T3, tagOnly: true });
    assert.deepStrictEqual(await reader.latest('acme/lib'), {
      version: 'v1.4.0',
      published: T2,
      url: 'https://github.com/acme/lib/releases/tag/v1.4.0',
      notes: 'French',
    });
  });

  it('answers the newest tag of a repository with no published release to the release reader', async () => {
    const { github, reader } = await merged();
    github.release('acme/lib', { tag: 'v1.4.0', commit: TAGGED, at: T2, tagOnly: true });
    github.release('acme/lib', { tag: 'v1.3.1', commit: LATER, at: T0, tagOnly: true });
    assert.deepStrictEqual(await reader.latest('acme/lib'), {
      version: 'v1.4.0',
      published: T2,
      tag: true,
    });
  });

  it('answers no release and no tag of a repository it never released', async () => {
    const { github, reader } = await merged();
    github.release('acme/web', { tag: 'v9.0.0', commit: TAGGED, at: T2 });
    assert.equal(await reader.latest('acme/lib'), undefined);
  });

  it('compares a tag with its own commit, a merge before it and a commit after it', async () => {
    const { github } = await merged();
    github.release('acme/lib', { tag: 'v1.4.0', commit: TAGGED, at: T2 });
    const status = async (base: string, head: string) => {
      const path = `${api}/repos/acme/lib/compare/${base}...${head}?per_page=1`;
      const answer = await github.fetch(path);
      return answer.status === 200
        ? ((await answer.json()) as { status: string }).status
        : answer.status;
    };
    assert.deepStrictEqual(
      [
        await status('v1.4.0', TAGGED),
        await status('v1.4.0', MERGE),
        await status('v1.4.0', LATER),
        await status('v1.3.0', MERGE),
      ],
      ['identical', 'behind', 'ahead', 404],
    );
  });

  it("holds a merge in a release made after it, through the release reader's compare", async () => {
    const { github, url, reader } = await merged();
    github.release('acme/lib', { tag: 'v1.4.0', commit: TAGGED, at: T2 });
    const latest = await reader.latest('acme/lib');
    assert.ok(latest !== undefined);
    assert.equal(await reader.holds('acme/lib', latest, url), true);
  });

  it('holds a merge in a tag made after it, by the merge commit date', async () => {
    const { github, url, reader } = await merged();
    github.release('acme/lib', { tag: 'v1.4.0', commit: TAGGED, at: T2, tagOnly: true });
    const latest = await reader.latest('acme/lib');
    assert.ok(latest !== undefined);
    assert.equal(await reader.holds('acme/lib', latest, url), true);
  });

  it('holds no merge made after a release, though dated before it', async () => {
    const github = fakeGitHubApi({ login: 'ann', issues: {} });
    github.release('acme/lib', { tag: 'v1.4.0', commit: TAGGED, at: T2 });
    const answer = await github.fetch(`${api}/repos/acme/lib/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Greet', head: 'foedrum/8', base: 'main', body: 'B' }),
    });
    const { html_url: url, number } = (await answer.json()) as { html_url: string; number: number };
    // Merged where the release does not reach it: the compare says so, not the dates.
    github.merge('acme/lib', number, { sha: LATER, at: T1 });
    const client = createGitHubClient({ exec: ghOver(github.fetch).exec });
    const reader = githubReleaseReader(createGitHubReads(client), client);
    const latest = await reader.latest('acme/lib');
    assert.ok(latest !== undefined);
    assert.equal(await reader.holds('acme/lib', latest, url), false);
  });
});
