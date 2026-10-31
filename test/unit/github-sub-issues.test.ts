// The Brewery's sub-issues and "blocked by" links on GitHub (#723), against the fake GitHub API,
// which answers as spike #18 recorded (docs/design/intake/trackers.md), and a canned `fetch` for
// what each request sends; no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubSubIssues } from '../../src/github/sub-issues.ts';
import { fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeApiIssue, fakeGitHubApi, idOf } from '../helpers/fake-github-api.ts';

const brewery = 'acme/brewery';
const login = 'foedrum-bot';
const marker = '<!-- foedrum:["7-1","plan.api.issue"] -->';

const onFake = (issues: FakeApiIssue[] = []) => {
  const api = fakeGitHubApi({ login, issues: { [brewery]: issues } });
  const client = createGitHubClient({ exec: ghOver(api.fetch).exec });
  return { api, subIssues: githubSubIssues({ client, brewery, login }) };
};

// A new one each time: the fake records links on the issue it is given.
const order = (): FakeApiIssue => ({
  number: 7,
  labels: ['recipe:mash'],
  author: 'alice',
  title: 'Order',
});

describe('githubSubIssues', () => {
  it('opens an issue with its labels and reads its id', async () => {
    const { api, subIssues } = onFake([order()]);
    const opened = await subIssues.openIssue('Add the API', `Body\n\n${marker}`, [
      'recipe:nip',
      'needs-refinement',
    ]);
    assert.deepStrictEqual(opened, { number: 8, id: idOf(8) });
    const made = api.issue(brewery, 8);
    assert.deepStrictEqual(made?.labels, ['recipe:nip', 'needs-refinement']);
    assert.equal(made?.title, 'Add the API');
    assert.equal(made?.author, login);
  });

  it('finds an issue it opened again by its marker, and none by another or by someone else', async () => {
    const planted: FakeApiIssue = {
      number: 9,
      labels: [],
      author: 'mallory',
      body: `Planted\n\n${marker}`,
      id: 555,
    };
    const { subIssues } = onFake([order(), planted]);
    assert.equal(await subIssues.findIssue(marker), undefined);
    const opened = await subIssues.openIssue('Add the API', `Body\n\n${marker}`, []);
    assert.deepStrictEqual(await subIssues.findIssue(marker), opened);
    assert.equal(await subIssues.findIssue('<!-- foedrum:["7-1","plan.web.issue"] -->'), undefined);
  });

  it('adds a sub-issue by its id and reads the list back in order', async () => {
    const { api, subIssues } = onFake([order()]);
    const first = await subIssues.openIssue('First', 'one', []);
    const second = await subIssues.openIssue('Second', 'two', []);
    await subIssues.addSubIssue(7, second.id);
    await subIssues.addSubIssue(7, first.id);
    assert.deepStrictEqual(await subIssues.subIssues(7), [second, first]);
    assert.deepStrictEqual(api.issue(brewery, 7)?.subIssues, [second.number, first.number]);
  });

  it('a repeated add answers 422, and a list read shows the sub-issue is there', async () => {
    const { subIssues } = onFake([order()]);
    const child = await subIssues.openIssue('Child', 'one', []);
    await subIssues.addSubIssue(7, child.id);
    await assert.rejects(subIssues.addSubIssue(7, child.id), /GitHub answered 422 .*duplicate/);
    assert.deepStrictEqual(await subIssues.subIssues(7), [child]);
  });

  it('adds and reads "blocked by"', async () => {
    const { subIssues } = onFake([order()]);
    const blocker = await subIssues.openIssue('Blocker', 'one', []);
    const blocked = await subIssues.openIssue('Blocked', 'two', []);
    assert.deepStrictEqual(await subIssues.blockedBy(blocked.number), []);
    await subIssues.addBlockedBy(blocked.number, blocker.id);
    assert.deepStrictEqual(await subIssues.blockedBy(blocked.number), [blocker]);
    assert.deepStrictEqual(await subIssues.blockedBy(blocker.number), []);
    await assert.rejects(
      subIssues.addBlockedBy(blocked.number, blocker.id),
      /GitHub answered 422 .*already been taken/,
    );
  });

  it('finds no pull request by its marker, and asks nothing for an issue number that is none', async () => {
    const { api, subIssues } = onFake([order()]);
    const fetched = api.requests.length;
    for (const issue of [0, -1, 1.5]) {
      await assert.rejects(subIssues.subIssues(issue), /positive integer/);
      await assert.rejects(subIssues.addBlockedBy(issue, idOf(7)), /positive integer/);
    }
    assert.equal(api.requests.length, fetched);
    const pull = { id: 777, number: 3, state: 'open', user: { login }, labels: [], body: marker };
    const fake = fakeFetch([{ status: 200, body: [{ ...pull, pull_request: {} }] }]);
    const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
    assert.equal(await githubSubIssues({ client, brewery, login }).findIssue(marker), undefined);
  });

  it('sends the numeric id and the API version 2026-03-10 on every call', async () => {
    const issue = (number: number) => ({
      id: idOf(number),
      number,
      state: 'open',
      user: { login },
      labels: [],
      body: marker,
    });
    const fake = fakeFetch([
      { status: 200, body: [issue(8)] },
      { status: 201, body: issue(9) },
      { status: 200, body: [] },
      { status: 201, body: issue(7) },
      { status: 200, body: [] },
      { status: 201, body: issue(9) },
    ]);
    const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
    const subIssues = githubSubIssues({ client, brewery, login });
    await subIssues.findIssue(marker);
    await subIssues.openIssue('Title', 'Body', ['recipe:nip']);
    await subIssues.subIssues(7);
    await subIssues.addSubIssue(7, idOf(9));
    await subIssues.blockedBy(9);
    await subIssues.addBlockedBy(9, idOf(8));
    const root = 'https://api.github.com/repos/acme/brewery';
    assert.deepStrictEqual(
      fake.requests.map(({ method, url, body }) => ({ method, url, body })),
      [
        {
          method: 'GET',
          url: `${root}/issues?state=all&creator=foedrum-bot&per_page=10`,
          body: undefined,
        },
        {
          method: 'POST',
          url: `${root}/issues`,
          body: { title: 'Title', body: 'Body', labels: ['recipe:nip'] },
        },
        { method: 'GET', url: `${root}/issues/7/sub_issues?per_page=10`, body: undefined },
        { method: 'POST', url: `${root}/issues/7/sub_issues`, body: { sub_issue_id: idOf(9) } },
        {
          method: 'GET',
          url: `${root}/issues/9/dependencies/blocked_by?per_page=10`,
          body: undefined,
        },
        {
          method: 'POST',
          url: `${root}/issues/9/dependencies/blocked_by`,
          body: { issue_id: idOf(8) },
        },
      ],
    );
    for (const { headers } of fake.requests) {
      assert.equal(headers['x-github-api-version'], '2026-03-10');
    }
  });
});
